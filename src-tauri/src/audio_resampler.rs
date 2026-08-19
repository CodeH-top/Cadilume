//! Per-track PCM preparation.
//!
//! A track is decoded and converted on its own worker before it is attached to
//! the shared rodio mixer. This keeps the real-time output callback free from
//! both network/decoder stalls and the low-quality linear converter used by
//! rodio's `UniformSourceIterator`.

use std::collections::VecDeque;
use std::time::Duration;

use rodio::source::SeekError;
use rodio::{ChannelCount, SampleRate, Source};
use rubato::audioadapter_buffers::direct::InterleavedSlice;
use rubato::{Async, FixedAsync, Indexing, Resampler, SincInterpolationParameters, WindowFunction};

const RESAMPLER_CHUNK_FRAMES: usize = 1024;
const SINC_LENGTH: usize = 256;

/// A source whose channel layout and sample rate are fixed before it reaches
/// the shared mixer. The resampler is intentionally owned by the decoder
/// worker: `next()` on the audio callback only drains `VecDeque`/decoded PCM.
pub(crate) struct PreprocessedSource<S> {
    inner: S,
    source_channels: usize,
    resample_ratio: Option<f64>,
    target_channels: ChannelCount,
    target_rate: SampleRate,
    resampler: Option<Async<f32>>,
    input: Vec<f32>,
    output: VecDeque<f32>,
    source_finished: bool,
    output_finished: bool,
}

pub(crate) fn preprocess_source_for_output<S>(
    source: S,
    target_channels: ChannelCount,
    target_rate: SampleRate,
) -> Result<PreprocessedSource<S>, String>
where
    S: Source<Item = f32>,
{
    PreprocessedSource::new(source, target_channels, target_rate)
}

impl<S> PreprocessedSource<S>
where
    S: Source<Item = f32>,
{
    fn new(
        source: S,
        target_channels: ChannelCount,
        target_rate: SampleRate,
    ) -> Result<Self, String> {
        let source_channels = source.channels().get() as usize;
        let source_rate = source.sample_rate().get();
        let target_channel_count = target_channels.get() as usize;
        let resample_ratio = (source_rate != target_rate.get())
            .then_some(target_rate.get() as f64 / source_rate as f64);
        let resampler = (source_rate != target_rate.get())
            .then(|| {
                Async::<f32>::new_sinc(
                    resample_ratio.expect("resampling ratio exists when rates differ"),
                    1.1,
                    &SincInterpolationParameters::new(SINC_LENGTH, WindowFunction::BlackmanHarris2),
                    RESAMPLER_CHUNK_FRAMES,
                    target_channel_count,
                    FixedAsync::Input,
                )
                .map_err(|error| format!("创建高质量采样率转换器失败: {error}"))
            })
            .transpose()?;

        Ok(Self {
            inner: source,
            source_channels,
            resample_ratio,
            target_channels,
            target_rate,
            resampler,
            input: Vec::new(),
            output: VecDeque::new(),
            source_finished: false,
            output_finished: false,
        })
    }

    fn map_next_frame(&mut self) -> Option<Vec<f32>> {
        if self.source_finished {
            return None;
        }

        let mut source_frame = Vec::with_capacity(self.source_channels);
        for _ in 0..self.source_channels {
            match self.inner.next() {
                Some(sample) => source_frame.push(sample),
                None => {
                    self.source_finished = true;
                    if source_frame.is_empty() {
                        return None;
                    }
                    source_frame.resize(self.source_channels, 0.0);
                    break;
                }
            }
        }
        if source_frame.is_empty() {
            return None;
        }

        let target_channels = self.target_channels.get() as usize;
        let mut target_frame = Vec::with_capacity(target_channels);
        if self.source_channels == target_channels {
            target_frame.extend_from_slice(&source_frame);
        } else if target_channels == 1 {
            let sum: f32 = source_frame.iter().copied().sum();
            target_frame.push(sum / source_frame.len() as f32);
        } else {
            for channel in 0..target_channels {
                target_frame.push(source_frame[channel % source_frame.len()]);
            }
        }
        Some(target_frame)
    }

    fn fill_passthrough(&mut self) {
        while self.output.is_empty() {
            let Some(frame) = self.map_next_frame() else {
                self.output_finished = true;
                break;
            };
            self.output.extend(frame);
        }
    }

    fn fill_resampled(&mut self) {
        let Some(resampler) = self.resampler.as_ref() else {
            self.fill_passthrough();
            return;
        };

        let input_frames = resampler.input_frames_next();
        let output_frames = resampler.output_frames_max();
        let target_channels = self.target_channels.get() as usize;
        self.input.clear();
        let mut actual_frames = 0;
        while actual_frames < input_frames {
            let Some(frame) = self.map_next_frame() else {
                break;
            };
            self.input.extend(frame);
            actual_frames += 1;
        }
        if actual_frames == 0 {
            self.output_finished = true;
            return;
        }

        let input_len = self.input.len();
        let input = InterleavedSlice::new(&self.input, target_channels, actual_frames)
            .expect("mapped audio input must be frame aligned");
        let mut output_samples = vec![0.0; output_frames * target_channels];
        let mut output =
            InterleavedSlice::new_mut(&mut output_samples, target_channels, output_frames)
                .expect("resampler output must be frame aligned");
        let indexing =
            (actual_frames < input_frames).then(|| Indexing::new().partial_len(actual_frames));
        let (_, produced_frames) = self
            .resampler
            .as_mut()
            .expect("resampler exists after the preparation branch")
            .process_into_buffer(&input, &mut output, indexing.as_ref())
            .unwrap_or_else(|error| {
                panic!(
                    "高质量采样率转换失败（input_samples={input_len}, input_frames={actual_frames}）: {error}"
                )
            });
        let frames_to_keep = if actual_frames < input_frames {
            let ratio = self
                .resample_ratio
                .expect("resampling ratio exists for resampled input");
            ((actual_frames as f64 * ratio).round() as usize).min(produced_frames)
        } else {
            produced_frames
        };
        self.output.extend(
            output_samples
                .into_iter()
                .take(frames_to_keep * target_channels),
        );
        if actual_frames < input_frames {
            self.output_finished = true;
        }
    }

    fn reset_after_seek(&mut self) {
        self.output.clear();
        self.input.clear();
        self.source_finished = false;
        self.output_finished = false;
        if let Some(resampler) = self.resampler.as_mut() {
            resampler.reset();
        }
    }
}

impl<S> Iterator for PreprocessedSource<S>
where
    S: Source<Item = f32>,
{
    type Item = f32;

    fn next(&mut self) -> Option<Self::Item> {
        if self.output.is_empty() && !self.output_finished {
            if self.resampler.is_some() {
                self.fill_resampled();
            } else {
                self.fill_passthrough();
            }
        }
        self.output.pop_front()
    }
}

impl<S> Source for PreprocessedSource<S>
where
    S: Source<Item = f32>,
{
    fn current_span_len(&self) -> Option<usize> {
        Some(self.output.len())
    }

    fn channels(&self) -> ChannelCount {
        self.target_channels
    }

    fn sample_rate(&self) -> SampleRate {
        self.target_rate
    }

    fn total_duration(&self) -> Option<Duration> {
        self.inner.total_duration()
    }

    fn try_seek(&mut self, pos: Duration) -> Result<(), SeekError> {
        self.inner.try_seek(pos)?;
        self.reset_after_seek();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::num::{NonZeroU16, NonZeroU32};

    struct FiniteSource {
        samples: Vec<f32>,
        cursor: usize,
        channels: ChannelCount,
        sample_rate: SampleRate,
    }

    impl Iterator for FiniteSource {
        type Item = f32;

        fn next(&mut self) -> Option<Self::Item> {
            let sample = self.samples.get(self.cursor).copied();
            self.cursor += usize::from(sample.is_some());
            sample
        }
    }

    impl Source for FiniteSource {
        fn current_span_len(&self) -> Option<usize> {
            Some(self.samples.len().saturating_sub(self.cursor))
        }

        fn channels(&self) -> ChannelCount {
            self.channels
        }

        fn sample_rate(&self) -> SampleRate {
            self.sample_rate
        }

        fn total_duration(&self) -> Option<Duration> {
            Some(Duration::from_secs_f64(
                self.samples.len() as f64
                    / self.channels.get() as f64
                    / self.sample_rate.get() as f64,
            ))
        }
    }

    #[test]
    fn resamples_in_worker_format_and_preserves_stereo_layout() {
        let source = FiniteSource {
            samples: vec![0.5; 44_100],
            cursor: 0,
            channels: NonZeroU16::new(1).unwrap(),
            sample_rate: NonZeroU32::new(44_100).unwrap(),
        };
        let target_channels = NonZeroU16::new(2).unwrap();
        let target_rate = NonZeroU32::new(48_000).unwrap();
        let prepared = preprocess_source_for_output(source, target_channels, target_rate).unwrap();
        assert_eq!(prepared.channels(), target_channels);
        assert_eq!(prepared.sample_rate(), target_rate);

        let samples: Vec<f32> = prepared.collect();
        assert_eq!(samples.len() % 2, 0);
        let output_frames = samples.len() / 2;
        assert!(output_frames.abs_diff(48_000) <= 256);
        assert!(samples
            .chunks_exact(2)
            .skip(256)
            .take(output_frames.saturating_sub(512))
            .all(|frame| (frame[0] - 0.5).abs() < 0.01 && (frame[1] - 0.5).abs() < 0.01));
    }

    #[test]
    fn downmixes_stereo_before_playback_without_losing_frame_alignment() {
        let source = FiniteSource {
            samples: vec![1.0, -1.0, 0.5, 0.5],
            cursor: 0,
            channels: NonZeroU16::new(2).unwrap(),
            sample_rate: NonZeroU32::new(48_000).unwrap(),
        };
        let prepared = preprocess_source_for_output(
            source,
            NonZeroU16::new(1).unwrap(),
            NonZeroU32::new(48_000).unwrap(),
        )
        .unwrap();
        let samples: Vec<f32> = prepared.collect();
        assert_eq!(samples, vec![0.0, 0.5]);
    }
}
