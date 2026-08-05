import { describe, expect, it } from "vitest";
import { isCurrentLibraryDetailRoute, libraryDetailRoute, libraryRouteHash, libraryTracksRoute, parseLibraryRoute } from "./libraryRoute";

describe("library routes", () => {
  it("maps primary views to stable hash routes", () => {
    expect(libraryRouteHash("home")).toBe("#/home");
    expect(libraryRouteHash("albums")).toBe("#/albums");
    expect(parseLibraryRoute("#/artists")).toEqual({ view: "artists" });
    expect(parseLibraryRoute("#/settings")).toEqual({ view: "settings" });
  });

  it("round-trips a search query and falls back from unknown routes", () => {
    const hash = libraryRouteHash("search", "  Jay Chou  ");
    expect(hash).toBe("#/search?q=Jay+Chou");
    expect(parseLibraryRoute(hash)).toEqual({ view: "search", query: "Jay Chou" });
    expect(parseLibraryRoute("#/unknown")).toEqual({ view: "home" });
    expect(parseLibraryRoute("")).toEqual({ view: "home" });
  });

  it("normalizes only valid server-pagination and sort parameters for tracks", () => {
    const route = libraryTracksRoute(4, { key: "duration", direction: "desc" });
    expect(libraryRouteHash(route)).toBe("#/tracks?page=4&sort=duration&direction=desc");
    expect(parseLibraryRoute(libraryRouteHash(route))).toEqual(route);
    expect(parseLibraryRoute("#/tracks?page=0&sort=unknown&direction=asc")).toEqual({ view: "tracks" });
    expect(parseLibraryRoute("#/tracks?sort=album&direction=asc")).toEqual({
      view: "tracks",
      tracks: { page: 1, sort: { key: "album", direction: "asc" } },
    });
  });

  it("round-trips artist, album, and playlist detail routes", () => {
    const artistRoute = libraryDetailRoute("artist", "artist-42");
    const albumRoute = libraryDetailRoute("album", "album-24");
    const playlistRoute = libraryDetailRoute("playlist", "playlist-7");

    expect(libraryRouteHash(artistRoute)).toBe("#/artists/artist-42");
    expect(parseLibraryRoute(libraryRouteHash(artistRoute))).toEqual(artistRoute);
    expect(parseLibraryRoute(libraryRouteHash(albumRoute))).toEqual(albumRoute);
    expect(parseLibraryRoute(libraryRouteHash(playlistRoute))).toEqual(playlistRoute);
  });

  it("identifies the current detail route before a duplicate navigation is created", () => {
    const currentArtist = libraryDetailRoute("artist", "artist-42");

    expect(isCurrentLibraryDetailRoute(currentArtist, "artist", "artist-42")).toBe(true);
    expect(isCurrentLibraryDetailRoute(currentArtist, "artist", " artist-42 ")).toBe(true);
    expect(isCurrentLibraryDetailRoute(currentArtist, "album", "artist-42")).toBe(false);
    expect(isCurrentLibraryDetailRoute(currentArtist, "artist", "artist-24")).toBe(false);
    expect(isCurrentLibraryDetailRoute({ view: "artists" }, "artist", "artist-42")).toBe(false);
  });

  it("encodes detail identifiers and rejects malformed detail paths", () => {
    const route = libraryDetailRoute("artist", "artist/周杰伦 1");
    expect(libraryRouteHash(route)).toBe("#/artists/artist%2F%E5%91%A8%E6%9D%B0%E4%BC%A6%201");
    expect(parseLibraryRoute(libraryRouteHash(route))).toEqual(route);
    expect(parseLibraryRoute("#/artists/%E0%A4%A")).toEqual({ view: "home" });
    expect(parseLibraryRoute("#/playlists/")).toEqual({ view: "home" });
    expect(parseLibraryRoute("#/artists/one/extra")).toEqual({ view: "home" });
  });
});
