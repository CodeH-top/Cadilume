import type { BootstrapResponse, LibrarySection, PlexItem, PlexServer } from "./types";

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
    Media: [{ audioCodec: index % 2 ? "flac" : "aac", container: index % 2 ? "flac" : "m4a", bitrate: index % 2 ? 941 : 256, Part: [{ key: `/library/parts/${index}/file.${index % 2 ? "flac" : "m4a"}` }] }],
  };
});
