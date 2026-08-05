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

  it("does not render a lyrics entry in the expanded player", () => {
    const markup = renderExpandedPlayer();

    expect(markup).not.toContain('aria-label="打开歌词"');
    expect(markup).not.toContain('aria-label="歌词不可用：暂无歌词"');
  });

  it("keeps app-level appearance and connection actions in the title bar", () => {
    const markup = renderExpandedPlayer();
    const headerEnd = markup.indexOf("now-playing-content");

    expect(markup.slice(0, headerEnd)).toContain('data-testid="expanded-player-header-actions"');
  });
});
