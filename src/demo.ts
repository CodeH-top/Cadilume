import type { BootstrapResponse, LibrarySection, PlexHub, PlexItem, PlexPlaylist, PlexServer } from "./types";

const albumNames = ["Night Drive", "Soft Focus", "City After Rain", "In Between", "Northbound", "Quiet Hours"];
const artistNames = ["The Paper Moons", "Mira Lin", "Coastal Lines", "Sunday Club", "Atlas Park", "June & Harbor"];
const coverPalettes = [
  ["#171922", "#8b3d32", "#f4af72"],
  ["#1d2934", "#476b77", "#cce3de"],
  ["#202431", "#455c9a", "#d79b79"],
  ["#29221e", "#8b704c", "#ead6ad"],
  ["#111d22", "#28675f", "#a1d6b8"],
  ["#241b2b", "#674b78", "#e0b4cf"],
] as const;

function demoCover(title: string, index: number): string {
  const [deep, mid, accent] = coverPalettes[index % coverPalettes.length];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 640">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop stop-color="${deep}"/><stop offset="1" stop-color="${mid}"/>
      </linearGradient>
      <radialGradient id="glow" cx="72%" cy="18%" r="72%">
        <stop stop-color="${accent}" stop-opacity=".72"/><stop offset="1" stop-color="${accent}" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect width="640" height="640" fill="url(#bg)"/>
    <rect width="640" height="640" fill="url(#glow)"/>
    <circle cx="188" cy="318" r="164" fill="none" stroke="${accent}" stroke-opacity=".18" stroke-width="52"/>
    <circle cx="188" cy="318" r="95" fill="${deep}" fill-opacity=".62" stroke="${accent}" stroke-opacity=".44" stroke-width="2"/>
    <path d="M382 102h150l-72 72h72l-150 150 50-112h-76z" fill="${accent}" fill-opacity=".9"/>
    <path d="M88 510h464" stroke="${accent}" stroke-opacity=".4"/>
    <text x="88" y="556" fill="#fff" font-family="system-ui,-apple-system,sans-serif" font-size="36" font-weight="700">${title}</text>
    <text x="90" y="588" fill="#fff" fill-opacity=".62" font-family="system-ui,-apple-system,sans-serif" font-size="13" letter-spacing="4">CADILUME · DEMO</text>
  </svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

const covers = albumNames.map(demoCover);

export const demoBootstrap: BootstrapResponse = {
  clientIdentifier: "demo-client",
  authenticated: true,
  closeBehavior: "tray",
  deviceName: "演示 Mac",
  syncRecentPlays: false,
  brandPreset: "amber",
  account: {
    id: 1,
    username: "hogan",
    title: "Hogan",
    email: "demo@example.com",
    home: true,
    restricted: false,
    subscriptionActive: false,
  },
};

export const demoServers: PlexServer[] = [
  {
    id: "demo-server",
    name: "客厅音乐库",
    owned: false,
    home: true,
    sourceTitle: "家庭共享",
    connectionUri: "https://plex.local",
    local: true,
    relay: false,
    secure: true,
  },
];

export const demoSections: LibrarySection[] = [
  { key: "1", title: "Music", type: "artist" },
];

export const demoAlbums: PlexItem[] = albumNames.map((title, index) => ({
  ratingKey: `album-${index}`,
  key: `/library/metadata/album-${index}/children`,
  type: "album",
  title,
  titleSort: title,
  parentTitle: artistNames[index],
  year: 2026 - index,
  imageUrl: covers[index],
  thumb: covers[index],
  addedAt: Date.now() / 1000 - index * 86_400,
}));

export const demoArtists: PlexItem[] = artistNames.map((title, index) => ({
  ratingKey: `artist-${index}`,
  key: `/library/metadata/artist-${index}/children`,
  type: "artist",
  title,
  titleSort: title,
  imageUrl: covers[index],
  thumb: covers[index],
}));

export const demoTracks: PlexItem[] = Array.from({ length: 18 }, (_, index) => {
  const albumIndex = index % demoAlbums.length;
  return {
    ratingKey: `track-${index}`,
    key: `/library/metadata/track-${index}`,
    type: "track",
    title: ["Open Window", "Leave the Light On", "Last Train", "Small Hours", "Same Street", "Turning Blue"][index % 6] + (index > 5 ? ` ${Math.floor(index / 6) + 1}` : ""),
    parentTitle: albumNames[albumIndex],
    parentRatingKey: `album-${albumIndex}`,
    grandparentTitle: artistNames[albumIndex],
    grandparentRatingKey: `artist-${albumIndex}`,
    duration: 178_000 + index * 4_700,
    index: (index % 9) + 1,
    thumb: covers[albumIndex],
    imageUrl: covers[albumIndex],
    lastViewedAt: Date.now() / 1000 - index * 7_200,
    viewCount: Math.max(1, 18 - index),
    Media: [{ audioCodec: index % 2 ? "flac" : "aac", container: index % 2 ? "flac" : "m4a", bitrate: index % 2 ? 941 : 256, Part: [{ key: `/library/parts/${index}/file.${index % 2 ? "flac" : "m4a"}` }] }],
  };
});

interface DemoPlaylistDefinition {
  id: string;
  title: string;
  summary: string;
  smart: boolean;
  readOnly: boolean;
  trackIndexes: number[];
}

const demoPlaylistDefinitions: DemoPlaylistDefinition[] = [
  { id: "playlist-morning", title: "晨间慢醒", summary: "适合清晨的柔和节奏", smart: false, readOnly: false, trackIndexes: [0, 1, 6, 7, 12, 13] },
  { id: "playlist-commute", title: "通勤路线", summary: "城市移动中的熟悉旋律", smart: false, readOnly: false, trackIndexes: [2, 3, 8, 9, 14, 15] },
  { id: "playlist-focus", title: "安静专注", summary: "留给工作与阅读的空间", smart: false, readOnly: false, trackIndexes: [4, 5, 10, 11, 16, 17] },
  { id: "playlist-night", title: "深夜驾驶", summary: "夜色、公路与低亮度灯光", smart: false, readOnly: false, trackIndexes: [0, 3, 6, 9, 12, 15] },
  { id: "playlist-weekend", title: "周末客厅", summary: "无需跳过的轻松播放顺序", smart: false, readOnly: false, trackIndexes: [1, 4, 7, 10, 13, 16] },
  { id: "playlist-favorites", title: "长久收藏", summary: "反复回到的私人收藏", smart: false, readOnly: false, trackIndexes: [2, 5, 8, 11, 14, 17] },
  { id: "playlist-rain", title: "雨天窗边", summary: "适合阴雨天气的温和歌单", smart: false, readOnly: false, trackIndexes: [0, 4, 8, 12, 16] },
  { id: "playlist-road", title: "远途播放", summary: "为一段更长的旅程准备", smart: false, readOnly: false, trackIndexes: [1, 5, 9, 13, 17] },
  { id: "playlist-smart-recent", title: "最近加入", summary: "自动收录最近进入媒体库的歌曲", smart: true, readOnly: false, trackIndexes: [12, 13, 14, 15, 16, 17] },
  { id: "playlist-smart-unheard", title: "还没听过", summary: "自动寻找尚未播放的歌曲", smart: true, readOnly: false, trackIndexes: [6, 7, 8, 9, 10, 11] },
  { id: "playlist-smart-flac", title: "无损音频", summary: "自动聚合媒体库中的 FLAC", smart: true, readOnly: false, trackIndexes: [1, 3, 5, 7, 9, 11] },
  { id: "playlist-smart-often", title: "近期常听", summary: "根据最近播放动态更新", smart: true, readOnly: false, trackIndexes: [0, 2, 4, 6, 8, 10] },
  { id: "playlist-shared-family", title: "家庭共享", summary: "由家庭服务器管理员共享", smart: false, readOnly: true, trackIndexes: [2, 4, 6, 8, 10, 12] },
  { id: "playlist-shared-friends", title: "朋友的精选", summary: "只读的共享音乐清单", smart: false, readOnly: true, trackIndexes: [3, 5, 7, 9, 11, 13] },
  { id: "playlist-shared-archive", title: "旧日存档", summary: "来自共享服务器的只读存档", smart: false, readOnly: true, trackIndexes: [0, 5, 10, 15] },
];

export const demoPlaylists: PlexPlaylist[] = demoPlaylistDefinitions.map((definition, index) => {
  const items = definition.trackIndexes.map((trackIndex) => demoTracks[trackIndex]);
  return {
    ratingKey: definition.id,
    key: `/playlists/${definition.id}/items`,
    type: "playlist",
    title: definition.title,
    summary: definition.summary,
    playlistType: "audio",
    smart: definition.smart,
    readOnly: definition.readOnly,
    composite: covers[index % covers.length],
    leafCount: items.length,
    duration: items.reduce((total, track) => total + (track.duration ?? 0), 0),
    addedAt: Date.now() / 1000 - index * 43_200,
    lastViewedAt: index < 8 ? Date.now() / 1000 - index * 10_800 : undefined,
    viewCount: index < 8 ? 12 - index : undefined,
  };
});

export const demoRecommendationHubs: PlexHub[] = [
  {
    title: "最近播放的音乐",
    type: "track",
    identifier: "music.recentlyplayed.1",
    context: "hub.music.recentlyplayed",
    items: demoTracks.slice(0, 12),
  },
  {
    title: "常听专辑",
    type: "album",
    identifier: "music.topalbums.1",
    context: "hub.music.topalbums",
    items: [demoAlbums[1], demoAlbums[3], demoAlbums[5], demoAlbums[0]],
  },
  {
    title: "最近加入的音乐",
    type: "album",
    identifier: "music.recentlyadded.1",
    context: "hub.music.recentlyadded",
    items: demoAlbums,
  },
];

export const demoPlaylistItems: Readonly<Record<string, PlexItem[]>> = Object.fromEntries(
  demoPlaylistDefinitions.map((definition) => [
    definition.id,
    definition.trackIndexes.map((trackIndex) => demoTracks[trackIndex]),
  ]),
);
