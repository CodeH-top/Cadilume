import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NowPlayingView } from "./NowPlayingView";

function renderExpandedPlayer(playing = false, mode: "vinyl" | "artwork" = "vinyl") {
  return renderToStaticMarkup(
    <NowPlayingView
      open
      mode={mode}
      track={{ title: "布局验证歌曲", artist: "布局验证歌手", duration: 210_000 }}
      playing={playing}
      artwork={<img src="data:image/png;base64,cGxhY2Vob2xkZXI=" alt="布局验证封面" />}
      queueAvailable
      headerActions={<div data-testid="expanded-player-header-actions">外观与连接状态</div>}
      onSeek={() => undefined}
      onClose={() => undefined}
      onToggleQueue={() => undefined}
      onAddToPlaylist={() => undefined}
    />,
  );
}

describe("expanded player controller layout", () => {
  it("keeps track details on the left while playlist actions stay on the right", () => {
    const markup = renderExpandedPlayer();
    const headerEnd = markup.indexOf("now-playing-content");
    const controllerStart = markup.indexOf("now-playing-controller");
    const trackStart = markup.indexOf("now-playing-controller-track");
    const transportStart = markup.indexOf("now-playing-transport");
    const actionsStart = markup.indexOf("now-playing-panel-actions");

    expect(headerEnd).toBeGreaterThan(0);
    expect(markup.slice(0, headerEnd)).not.toContain("添加到歌单");
    expect(trackStart).toBeGreaterThan(controllerStart);
    expect(trackStart).toBeLessThan(transportStart);
    expect(transportStart).toBeLessThan(actionsStart);
    expect(markup.slice(trackStart, transportStart)).toContain("布局验证歌曲");
    expect(markup.slice(trackStart, transportStart)).not.toContain("歌词");
    expect(markup.slice(actionsStart)).toContain('aria-label="添加到歌单"');
    expect(markup.slice(actionsStart)).toContain('aria-label="显示播放队列"');
  });

  it("keeps the right-side lyrics surface without adding a footer lyrics button", () => {
    const markup = renderExpandedPlayer();
    const controllerStart = markup.indexOf("now-playing-controller");

    expect(markup).toContain('aria-label="展开播放器歌词"');
    expect(markup).toContain("这首歌暂无可用歌词");
    expect(markup).not.toContain('aria-label="打开歌词"');
    expect(markup.slice(controllerStart)).not.toContain("歌词");
  });

  it("marks only the playback-matched timed lyric as current", () => {
    const markup = renderToStaticMarkup(
      <NowPlayingView
        open
        track={{ title: "歌词状态验证", artist: "验证歌手", duration: 8_000 }}
        playing
        lyrics={{
          document: {
            format: "lrc",
            timed: true,
            offsetMs: 0,
            lines: [
              { id: "line-1", startMs: 0, endMs: 4_000, texts: ["上一句"] },
              { id: "line-2", startMs: 4_000, endMs: 8_000, texts: ["当前句"] },
            ],
          },
          activeIndex: 1,
        }}
        onSeek={() => undefined}
        onClose={() => undefined}
      />,
    );
    const activeLines = markup.match(/<button[^>]*class="[^"]*now-playing-lyric-line[^"]*is-active[^"]*"[^>]*>.*?<\/button>/g);

    expect(activeLines).toHaveLength(1);
    expect(activeLines?.[0]).toContain('aria-current="true"');
    expect(activeLines?.[0]).toContain("当前句");
  });

  it("keeps the close control left while the mode switch precedes the right-side appearance actions", () => {
    const markup = renderExpandedPlayer();
    const headerEnd = markup.indexOf("now-playing-content");
    const leadingStart = markup.indexOf("now-playing-header-leading");
    const spacerStart = markup.indexOf("now-playing-header-spacer");
    const closeStart = markup.indexOf('aria-label="关闭正在播放"');
    const modeSwitchStart = markup.indexOf("now-playing-mode-switch");
    const appActionsStart = markup.indexOf('data-testid="expanded-player-header-actions"');

    expect(markup.slice(0, headerEnd)).toContain('data-testid="expanded-player-header-actions"');
    expect(leadingStart).toBeGreaterThan(0);
    expect(spacerStart).toBeGreaterThan(leadingStart);
    expect(markup.slice(leadingStart, spacerStart)).toContain('aria-label="关闭正在播放"');
    expect(markup.slice(leadingStart, spacerStart)).not.toContain("now-playing-mode-switch");
    expect(closeStart).toBeLessThan(modeSwitchStart);
    expect(modeSwitchStart).toBeGreaterThan(0);
    expect(modeSwitchStart).toBeLessThan(appActionsStart);
  });

  it("keeps the bent tonearm parts mounted with the vinyl stage", () => {
    const markup = renderExpandedPlayer();
    const tonearmStart = markup.indexOf("now-playing-tonearm");
    const recordStart = markup.indexOf('class="now-playing-record"');

    expect(tonearmStart).toBeGreaterThan(0);
    expect(tonearmStart).toBeLessThan(recordStart);
    expect(markup).toContain('data-testid="tonearm-pivot"');
    expect(markup).toContain('data-testid="tonearm-swing"');
    expect(markup).toContain('data-testid="tonearm-arm"');
    expect(markup).toContain('data-testid="tonearm-connection"');
    expect(markup).toContain('data-testid="tonearm-cartridge"');
    expect(markup).toContain('d="M150 20 C184 78 224 132 270 180"');
    expect(markup).toContain('cx="150" cy="20"');
    expect(markup).toContain('class="now-playing-tonearm-base-ring" cx="150" cy="20" r="14"');
    expect(markup).not.toContain("now-playing-tonearm-base-shadow");
    expect(markup).toContain('transform="translate(270 180) rotate(46)"');
    expect(markup.indexOf("now-playing-tonearm-base-cap")).toBeLessThan(markup.indexOf("now-playing-tonearm-swing"));
  });

  it("exposes distinct resting and playing tonearm states", () => {
    expect(renderExpandedPlayer()).toContain("now-playing-record-stage is-paused");
    const playingMarkup = renderExpandedPlayer(true);
    expect(playingMarkup).toContain("now-playing-record-stage is-playing");
    expect(playingMarkup).toContain('transform="translate(270 180) rotate(46)"');
  });

  it("keeps one persistent artwork node for both visual modes", () => {
    const vinylMarkup = renderExpandedPlayer(false, "vinyl");
    const artworkMarkup = renderExpandedPlayer(false, "artwork");

    expect(artworkMarkup).toContain("is-artwork-mode");
    expect(artworkMarkup).toContain('data-display-mode="artwork"');
    expect(artworkMarkup).toContain("布局验证封面");
    expect(artworkMarkup).not.toContain("now-playing-background-artwork");
    expect(artworkMarkup).not.toContain("now-playing-cover-artwork");
    expect(vinylMarkup.match(/data-testid="now-playing-artwork-node"/g)).toHaveLength(1);
    expect(artworkMarkup.match(/data-testid="now-playing-artwork-node"/g)).toHaveLength(1);
    expect(vinylMarkup).toContain("now-playing-visual-stage now-playing-record-stage");
    expect(artworkMarkup).toContain("now-playing-visual-stage now-playing-record-stage");
  });

  it("keeps transport controls tooltip-free while auxiliary icon actions remain described", () => {
    const markup = renderExpandedPlayer();
    const transportStart = markup.indexOf("now-playing-transport");
    const actionsStart = markup.indexOf("now-playing-panel-actions");
    const transportMarkup = markup.slice(transportStart, actionsStart);

    expect(transportStart).toBeGreaterThan(0);
    expect(actionsStart).toBeGreaterThan(transportStart);
    expect(transportMarkup).not.toContain("data-tooltip");
    for (const label of ["随机播放当前列表", "上一首", "播放", "下一首", "顺序播放，列表结束后停止"]) {
      expect(transportMarkup).toContain(`aria-label="${label}"`);
    }
    for (const label of ["添加到歌单", "显示播放队列"]) {
      expect(markup).toContain(`data-tooltip="${label}"`);
    }
    expect(markup).not.toContain("data-tooltip=\"关闭正在播放\"");
    expect(markup).not.toContain("title=\"关闭正在播放\"");
    expect(markup).not.toContain("data-tooltip=\"静音\"");
    expect(markup).not.toContain("title=\"静音\"");
    expect(markup).not.toContain("title=\"音量");
  });

  it("falls back to track metadata when a stream reports an infinite duration", () => {
    const markup = renderToStaticMarkup(
      <NowPlayingView
        open
        track={{ title: "无限时长流", artist: "流式歌手", duration: 210_000 }}
        durationSeconds={Number.POSITIVE_INFINITY}
        playing={false}
        queueAvailable
        onSeek={() => undefined}
        onClose={() => undefined}
        onToggleQueue={() => undefined}
        onAddToPlaylist={() => undefined}
      />,
    );
    const timelineStart = markup.indexOf('aria-label="播放进度"');
    const timeline = markup.slice(timelineStart);

    expect(timeline).toContain("3:30");
    expect(timeline).not.toContain("Infinity");
    expect(timeline).not.toContain("NaN");
  });
});
