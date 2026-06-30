import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import crypto from "node:crypto";
import type {
  Album,
  AuthStatus,
  LyricLine,
  MusicProvider,
  Playlist,
  PlaylistDetail,
  QrCodeResult,
  SearchResult,
  Song,
  SongUrlResult,
} from "./provider.js";

const require = createRequire(import.meta.url);
const ffmpegPath: string | null = require("ffmpeg-static");

const AUDIO_EXTENSIONS = new Set([
  ".mp3",
  ".flac",
  ".wav",
  ".m4a",
  ".aac",
  ".ogg",
  ".opus",
  ".webm",
  ".wma",
  ".alac",
  ".aiff",
  ".ape",
]);

interface LocalSongRecord extends Song {
  filePath: string;
  originalName: string;
  uploadedAt: string;
  size: number;
  mimeType: string;
}

function safeFileName(name: string): string {
  const base = path.basename(name || "audio");
  return base
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160) || "audio";
}

function titleFromFileName(name: string): string {
  return safeFileName(name).replace(/\.[^.]+$/, "") || "本地音频";
}

function isSupportedAudio(name: string, mimeType?: string): boolean {
  const ext = path.extname(name).toLowerCase();
  if (AUDIO_EXTENSIONS.has(ext)) return true;
  return !!mimeType && (mimeType.startsWith("audio/") || mimeType === "video/webm");
}

async function probeDurationSeconds(filePath: string): Promise<number> {
  return new Promise((resolve) => {
    const ffmpeg = spawn(ffmpegPath || "ffmpeg", ["-hide_banner", "-i", filePath], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    const timeout = setTimeout(() => {
      ffmpeg.kill("SIGKILL");
      resolve(0);
    }, 5000);
    ffmpeg.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    ffmpeg.on("error", () => {
      clearTimeout(timeout);
      resolve(0);
    });
    ffmpeg.on("close", () => {
      clearTimeout(timeout);
      const match = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (!match) {
        resolve(0);
        return;
      }
      const hours = Number(match[1]);
      const minutes = Number(match[2]);
      const seconds = Number(match[3]);
      const total = hours * 3600 + minutes * 60 + seconds;
      resolve(Number.isFinite(total) ? Math.round(total) : 0);
    });
  });
}

export class LocalMusicProvider implements MusicProvider {
  readonly platform = "local" as const;
  private readonly uploadDir: string;
  private readonly indexPath: string;
  private records: LocalSongRecord[] = [];

  constructor(uploadDir: string) {
    this.uploadDir = uploadDir;
    this.indexPath = path.join(uploadDir, "index.json");
    mkdirSync(uploadDir, { recursive: true });
    this.loadIndex();
  }

  private loadIndex(): void {
    try {
      const raw = readFileSync(this.indexPath, "utf8");
      const parsed = JSON.parse(raw) as LocalSongRecord[];
      this.records = Array.isArray(parsed)
        ? parsed.filter((r) => r && typeof r.id === "string" && typeof r.filePath === "string")
        : [];
    } catch {
      this.records = [];
    }
  }

  private saveIndex(): void {
    writeFileSync(this.indexPath, JSON.stringify(this.records, null, 2), "utf8");
  }

  async uploadAudio(input: {
    buffer: Buffer;
    originalName: string;
    mimeType?: string;
  }): Promise<Song> {
    const originalName = safeFileName(input.originalName || "audio");
    if (!isSupportedAudio(originalName, input.mimeType)) {
      throw new Error("只支持常见音频文件，如 mp3、flac、wav、m4a、ogg、opus、aac、webm");
    }
    if (!input.buffer || input.buffer.length === 0) {
      throw new Error("上传文件为空");
    }

    const id = crypto.randomUUID();
    const ext = path.extname(originalName).toLowerCase() || ".audio";
    const storedName = `${id}${ext}`;
    const filePath = path.join(this.uploadDir, storedName);
    writeFileSync(filePath, input.buffer);

    const duration = await probeDurationSeconds(filePath);
    const song: LocalSongRecord = {
      id,
      name: titleFromFileName(originalName),
      artist: "本地上传",
      album: "本地音乐",
      duration,
      coverUrl: "",
      platform: "local",
      filePath,
      originalName,
      uploadedAt: new Date().toISOString(),
      size: input.buffer.length,
      mimeType: input.mimeType || "application/octet-stream",
    };

    this.records.unshift(song);
    this.saveIndex();
    return this.toSong(song);
  }

  private toSong(record: LocalSongRecord): Song {
    const { filePath: _filePath, originalName: _originalName, uploadedAt: _uploadedAt, size: _size, mimeType: _mimeType, ...song } = record;
    return song;
  }

  async search(query: string, limit = 20): Promise<SearchResult> {
    const q = query.trim().toLowerCase();
    const songs = this.records
      .filter((r) => existsSync(r.filePath))
      .filter((r) => !q || `${r.name} ${r.artist} ${r.album} ${r.originalName}`.toLowerCase().includes(q))
      .slice(0, limit)
      .map((r) => this.toSong(r));
    return { songs, playlists: [], albums: [] };
  }

  async getSongUrl(songId: string): Promise<SongUrlResult | null> {
    const record = this.records.find((r) => r.id === songId);
    if (!record || !existsSync(record.filePath)) return null;
    return { url: record.filePath };
  }

  async getSongDetail(songId: string): Promise<Song | null> {
    const record = this.records.find((r) => r.id === songId);
    return record && existsSync(record.filePath) ? this.toSong(record) : null;
  }

  async deleteSong(songId: string): Promise<boolean> {
    const index = this.records.findIndex((r) => r.id === songId);
    if (index < 0) return false;

    const [record] = this.records.splice(index, 1);
    this.saveIndex();

    if (record?.filePath) {
      rmSync(record.filePath, { force: true });
    }
    return true;
  }

  setQuality(_quality: string): void {
    // 本地文件按原始音质播放。
  }

  getQuality(): string {
    return "original";
  }

  async getPlaylistSongs(_playlistId: string): Promise<Song[]> {
    return [];
  }

  async getRecommendPlaylists(): Promise<Playlist[]> {
    return [];
  }

  async getAlbumSongs(_albumId: string): Promise<Song[]> {
    return [];
  }

  async getLyrics(_songId: string): Promise<LyricLine[]> {
    return [];
  }

  async getQrCode(): Promise<QrCodeResult> {
    throw new Error("Local music does not require login");
  }

  async checkQrCodeStatus(_key: string): Promise<"waiting" | "scanned" | "confirmed" | "expired"> {
    return "expired";
  }

  setCookie(_cookie: string): void {
    // no-op
  }

  getCookie(): string {
    return "";
  }

  async getAuthStatus(): Promise<AuthStatus> {
    return { loggedIn: true, nickname: "本地音乐" };
  }

  async getPlaylistDetail(_playlistId: string): Promise<PlaylistDetail | null> {
    return null;
  }
}
