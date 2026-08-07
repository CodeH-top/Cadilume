import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NowPlayingView } from "./NowPlayingView";

function renderExpandedPlayer() {
  return renderToStaticMarkup(
    <NowPlayingView
      open
      track={{ title: "布局验证歌曲", artist: "布局验证歌手", duration: 210_000 }}
      playing={false}
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
    expect(markup).toContain('data-testid="tonearm-arm"');
    expect(markup).toContain('data-testid="tonearm-cartridge"');
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
