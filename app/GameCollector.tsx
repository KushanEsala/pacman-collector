"use client";

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  cloudConfigured,
  flushQueue,
  queueCount,
  submitRound,
  submitSession,
  submitSessionFeedback,
} from "../lib/supabase";
import type { Difficulty, Feedback, RoundRecord } from "../lib/types";

const CLIENT_VERSION = "web-collector-v9";
const CONSENT_VERSION = "2026-07-13";
const MAX_LEVELS = 5;
const MAX_RETRIES = 5;
const DIFFICULTIES: Difficulty[] = ["Easy", "Medium", "Hard"];
const DIFFICULTY_FACTOR: Record<Difficulty, number> = { Easy: 0, Medium: 1, Hard: 2 };
const EXPECTED_SECONDS: Record<Difficulty, number> = { Easy: 50, Medium: 60, Hard: 72 };

function buildFairMaze(rows: number, cols: number, level: number) {
  const grid = Array.from({ length: rows }, () => Array.from({ length: cols }, () => "#"));
  let seed = (level * 2654435761 + rows * 97 + cols * 53) >>> 0;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const shuffled = <T,>(values: T[]) => {
    const result = [...values];
    for (let index = result.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(random() * (index + 1));
      [result[index], result[swap]] = [result[swap], result[index]];
    }
    return result;
  };
  const carveDirections = [
    { row: -2, col: 0 }, { row: 2, col: 0 }, { row: 0, col: -2 }, { row: 0, col: 2 },
  ];
  const unitDirections = [
    { row: -1, col: 0 }, { row: 1, col: 0 }, { row: 0, col: -1 }, { row: 0, col: 1 },
  ];
  const stack: Point[] = [{ row: 1, col: 1 }];
  grid[1][1] = ".";
  while (stack.length > 0) {
    const current = stack[stack.length - 1];
    const next = shuffled(carveDirections)
      .map((direction) => ({ row: current.row + direction.row, col: current.col + direction.col }))
      .find((point) => point.row > 0 && point.row < rows - 1 && point.col > 0 && point.col < cols - 1 && grid[point.row][point.col] === "#");
    if (!next) {
      stack.pop();
      continue;
    }
    grid[(current.row + next.row) / 2][(current.col + next.col) / 2] = ".";
    grid[next.row][next.col] = ".";
    stack.push(next);
  }

  const passageDegree = (row: number, col: number) =>
    unitDirections.filter((direction) => grid[row + direction.row]?.[col + direction.col] === ".").length;
  let deadEnds = true;
  let braidPass = 0;
  while (deadEnds && braidPass < 4) {
    deadEnds = false;
    braidPass += 1;
    for (let row = 1; row < rows - 1; row += 2) {
      for (let col = 1; col < cols - 1; col += 2) {
        if (grid[row][col] !== "." || passageDegree(row, col) !== 1) continue;
        const links = shuffled(carveDirections).filter((direction) => {
          const targetRow = row + direction.row;
          const targetCol = col + direction.col;
          return targetRow > 0 && targetRow < rows - 1 && targetCol > 0 && targetCol < cols - 1 &&
            grid[targetRow][targetCol] === "." && grid[row + direction.row / 2][col + direction.col / 2] === "#";
        });
        if (links[0]) {
          grid[row + links[0].row / 2][col + links[0].col / 2] = ".";
        } else {
          deadEnds = true;
        }
      }
    }
  }

  // Extra cross-links keep chase routes readable and reduce long sandwich corridors.
  const loopChance = Math.max(0.08, 0.16 - level * 0.012);
  for (let row = 1; row < rows - 1; row += 1) {
    for (let col = 1; col < cols - 1; col += 1) {
      if (grid[row][col] !== "#" || random() > loopChance) continue;
      const horizontalLink = grid[row][col - 1] === "." && grid[row][col + 1] === ".";
      const verticalLink = grid[row - 1][col] === "." && grid[row + 1][col] === ".";
      if (horizontalLink !== verticalLink) grid[row][col] = ".";
    }
  }
  return grid.map((row) => row.join(""));
}

const MAZES = [
  buildFairMaze(9, 19, 1),
  buildFairMaze(11, 23, 2),
  buildFairMaze(13, 25, 3),
  buildFairMaze(15, 27, 4),
  buildFairMaze(17, 29, 5),
].map((maze, index) => validateFairMaze(maze, index + 1));

function validateFairMaze(maze: string[], level: number) {
  const passages = new Set<string>();
  maze.forEach((line, row) => [...line].forEach((cell, col) => {
    if (cell === ".") passages.add(`${row},${col}`);
  }));
  const start = passages.values().next().value as string | undefined;
  if (!start) throw new Error(`Level ${level} has no playable cells`);
  const visited = new Set([start]);
  const queue = [start];
  let deadEnds = 0;
  while (queue.length > 0) {
    const key = queue.shift()!;
    const [row, col] = key.split(",").map(Number);
    const neighbours = [[row - 1, col], [row + 1, col], [row, col - 1], [row, col + 1]]
      .map(([nextRow, nextCol]) => `${nextRow},${nextCol}`)
      .filter((next) => passages.has(next));
    if (neighbours.length <= 1) deadEnds += 1;
    neighbours.forEach((next) => {
      if (!visited.has(next)) {
        visited.add(next);
        queue.push(next);
      }
    });
  }
  if (visited.size !== passages.size || deadEnds > 0) {
    throw new Error(`Level ${level} failed fairness validation: ${passages.size - visited.size} unreachable, ${deadEnds} dead ends`);
  }
  return maze;
}

type Direction = "up" | "down" | "left" | "right";
type Screen = "profile" | "playing" | "feedback" | "round_result" | "session_complete";
type Point = { row: number; col: number };
type Ghost = Point & {
  color: string;
  spawn: Point;
  respawningUntil: number;
  eaten: number;
};

interface GameState {
  level: number;
  difficulty: Difficulty;
  roundId: string;
  maze: string[];
  player: Point;
  direction: Direction | null;
  queuedDirection: Direction | null;
  ghosts: Ghost[];
  dots: Set<string>;
  power: Set<string>;
  initialCollectibles: number;
  score: number;
  retries: number;
  errors: number;
  actions: number;
  inputAttempts: number;
  idleTicks: number;
  movementTicks: number;
  directionChanges: number;
  lastDirection: Direction | null;
  startedAt: number;
  firstActionAt: number | null;
  pausedAt: number | null;
  totalPausedMs: number;
  frozenUntil: number;
  readyUntil: number;
  playerSafeUntil: number;
  ghostCombo: number;
  ghostsEaten: number;
  lastPlayerMove: number;
  lastGhostMove: number;
  lastHudUpdate: number;
  ended: boolean;
}

const pointKey = (point: Point) => `${point.row},${point.col}`;
const vectors: Record<Direction, Point> = {
  up: { row: -1, col: 0 }, down: { row: 1, col: 0 }, left: { row: 0, col: -1 }, right: { row: 0, col: 1 },
};

function participantIdFor(code: string) {
  const key = `pacman-participant-${code.trim().toLowerCase()}`;
  const existing = localStorage.getItem(key);
  if (existing) return existing;
  const created = crypto.randomUUID();
  localStorage.setItem(key, created);
  return created;
}

function difficultyStart(code: string) {
  return [...code.toLowerCase()].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 3;
}

function difficultyFor(start: number, level: number): Difficulty {
  return DIFFICULTIES[(start + level - 1) % DIFFICULTIES.length];
}

function isOpen(maze: string[], point: Point) {
  return point.row >= 0 && point.row < maze.length && point.col >= 0 && point.col < maze[point.row].length && maze[point.row][point.col] !== "#";
}

function openCells(maze: string[]) {
  const cells: Point[] = [];
  maze.forEach((line, row) => [...line].forEach((cell, col) => cell !== "#" && cells.push({ row, col })));
  return cells;
}

function createGame(level: number, difficulty: Difficulty): GameState {
  const maze = MAZES[level - 1];
  const cells = openCells(maze);
  const player = { row: 1, col: 1 };
  const center = { row: Math.floor(maze.length / 2), col: Math.floor(maze[0].length / 2) };
  const station = [...cells]
    .filter((cell) => Math.abs(cell.row - 1) + Math.abs(cell.col - 1) > 8)
    .sort((a, b) =>
      (Math.abs(a.row - center.row) + Math.abs(a.col - center.col)) -
      (Math.abs(b.row - center.row) + Math.abs(b.col - center.col)),
    );
  const ghostCount = difficulty === "Easy" ? 2 : difficulty === "Medium" ? 3 : 4;
  const colors = ["#ef476f", "#4cc9f0", "#ff9f1c", "#f15bb5"];
  const ghosts = Array.from({ length: ghostCount }, (_, index) => {
    const spawn = station[index] ?? cells[cells.length - 2];
    return { ...spawn, spawn: { ...spawn }, color: colors[index], respawningUntil: 0, eaten: 0 };
  });
  const blocked = new Set([pointKey(player), ...ghosts.map(pointKey)]);
  const corners = cells.filter((cell) => (cell.row === 1 || cell.row === maze.length - 2) && (cell.col < 3 || cell.col > maze[0].length - 4));
  const powerCount = difficulty === "Easy" ? 4 : difficulty === "Medium" ? 3 : 2;
  const power = new Set(corners.slice(0, powerCount).map(pointKey));
  const dots = new Set(cells.filter((cell) => !blocked.has(pointKey(cell)) && !power.has(pointKey(cell))).map(pointKey));
  const now = performance.now();
  return {
    level, difficulty, roundId: crypto.randomUUID(), maze, player, direction: null, queuedDirection: null, ghosts,
    dots, power, initialCollectibles: dots.size + power.size, score: 0, retries: 0, errors: 0, actions: 0,
    inputAttempts: 0, idleTicks: 0, movementTicks: 0, directionChanges: 0, lastDirection: null,
    startedAt: now + 1200, firstActionAt: null, pausedAt: null, totalPausedMs: 0,
    frozenUntil: 0, readyUntil: now + 1200, playerSafeUntil: now + 2200,
    ghostCombo: 0, ghostsEaten: 0, lastPlayerMove: 0, lastGhostMove: 0, lastHudUpdate: 0, ended: false,
  };
}

function drawGame(canvas: HTMLCanvasElement, game: GameState, now = performance.now()) {
  const context = canvas.getContext("2d");
  if (!context) return;
  const width = canvas.width;
  const height = canvas.height;
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#070b18";
  context.fillRect(0, 0, width, height);
  const cell = Math.min((width - 28) / game.maze[0].length, (height - 28) / game.maze.length);
  const offsetX = (width - cell * game.maze[0].length) / 2;
  const offsetY = (height - cell * game.maze.length) / 2;
  game.maze.forEach((line, row) => [...line].forEach((value, col) => {
    const x = offsetX + col * cell;
    const y = offsetY + row * cell;
    if (value === "#") {
      context.fillStyle = "#153777";
      context.fillRect(x + 1, y + 1, cell - 2, cell - 2);
      context.strokeStyle = "#3f8cff";
      context.lineWidth = 1.5;
      context.strokeRect(x + 3, y + 3, cell - 6, cell - 6);
    }
  }));
  for (const key of game.dots) {
    const [row, col] = key.split(",").map(Number);
    context.fillStyle = "#f3f6ff";
    context.beginPath();
    context.arc(offsetX + (col + 0.5) * cell, offsetY + (row + 0.5) * cell, Math.max(2, cell * 0.08), 0, Math.PI * 2);
    context.fill();
  }
  for (const key of game.power) {
    const [row, col] = key.split(",").map(Number);
    context.fillStyle = "#ff8fe9";
    context.beginPath();
    context.arc(offsetX + (col + 0.5) * cell, offsetY + (row + 0.5) * cell, Math.max(4, cell * 0.18), 0, Math.PI * 2);
    context.fill();
  }
  const px = offsetX + (game.player.col + 0.5) * cell;
  const py = offsetY + (game.player.row + 0.5) * cell;
  const playerVisible = now >= game.playerSafeUntil || Math.floor(now / 100) % 2 === 0;
  context.fillStyle = playerVisible ? "#f9df4b" : "rgba(249, 223, 75, .24)";
  context.beginPath();
  context.arc(px, py, cell * 0.36, 0.18 * Math.PI, 1.82 * Math.PI);
  context.lineTo(px, py);
  context.fill();
  game.ghosts.forEach((ghost) => {
    const x = offsetX + (ghost.col + 0.5) * cell;
    const y = offsetY + (ghost.row + 0.5) * cell;
    const respawning = now < ghost.respawningUntil;
    context.fillStyle = respawning ? "rgba(125, 165, 232, .18)" : now < game.frozenUntil ? "#4776e6" : ghost.color;
    context.beginPath();
    context.arc(x, y - cell * 0.06, cell * 0.31, Math.PI, 0);
    context.lineTo(x + cell * 0.31, y + cell * 0.3);
    context.lineTo(x - cell * 0.31, y + cell * 0.3);
    context.closePath();
    context.fill();
    context.fillStyle = "white";
    context.beginPath(); context.arc(x - cell * 0.1, y - cell * 0.05, cell * 0.07, 0, Math.PI * 2); context.fill();
    context.beginPath(); context.arc(x + cell * 0.1, y - cell * 0.05, cell * 0.07, 0, Math.PI * 2); context.fill();
  });
  if (now < game.readyUntil) {
    context.fillStyle = "rgba(7, 11, 24, .66)";
    context.fillRect(0, 0, width, height);
    context.fillStyle = "#f9df4b";
    context.font = `800 ${Math.max(24, cell * 1.05)}px Arial`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText("READY", width / 2, height / 2);
  }
  if (now < game.frozenUntil) {
    const remaining = Math.max(0, (game.frozenUntil - now) / 1000);
    context.fillStyle = "rgba(9, 18, 40, .9)";
    context.fillRect(16, 14, 150, 34);
    context.fillStyle = "#9bbcff";
    context.font = "700 15px Arial";
    context.textAlign = "left";
    context.textBaseline = "middle";
    context.fillText(`GHOST FREEZE ${remaining.toFixed(1)}s`, 27, 31);
  }
}

export function GameCollector() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const workspaceRef = useRef<HTMLElement>(null);
  const gameRef = useRef<GameState | null>(null);
  const participantRef = useRef("");
  const sessionRef = useRef("");
  const startDifficultyRef = useRef(0);
  const pendingRecordRef = useRef<Omit<RoundRecord, "target_adjustment" | "player_feedback" | "label_source" | "label_confidence"> | null>(null);
  const swipeStartRef = useRef<Point | null>(null);
  const pausedRef = useRef(false);
  const [screen, setScreen] = useState<Screen>("profile");
  const [participantCode, setParticipantCode] = useState("");
  const [consent, setConsent] = useState(false);
  const [level, setLevel] = useState(1);
  const [difficulty, setDifficulty] = useState<Difficulty>("Easy");
  const [hud, setHud] = useState({ score: 0, retries: 0, remaining: 0, ghostsEaten: 0 });
  const [result, setResult] = useState({ title: "", detail: "" });
  const [pendingCount, setPendingCount] = useState(0);
  const [syncText, setSyncText] = useState(cloudConfigured ? "Cloud ready" : "Local queue mode");
  const [completedSessions, setCompletedSessions] = useState(0);
  const [sessionComment, setSessionComment] = useState("");
  const [feedbackSubmitting, setFeedbackSubmitting] = useState(false);
  const [feedbackSent, setFeedbackSent] = useState(false);
  const [paused, setPaused] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showMobilePlayPrompt, setShowMobilePlayPrompt] = useState(false);
  const [preferFullscreen, setPreferFullscreen] = useState(true);
  const [fullscreenError, setFullscreenError] = useState("");

  const refreshQueue = useCallback(() => setPendingCount(queueCount()), []);
  useEffect(() => {
    const initialRefreshId = window.setTimeout(refreshQueue, 0);
    window.addEventListener("pacman-queue-change", refreshQueue);
    const syncInBackground = () => void flushQueue().then(({ sent, remaining }) => {
      refreshQueue();
      if (sent) setSyncText(`${sent} queued records synced`);
      else setSyncText(remaining ? `${remaining} records waiting` : "Cloud ready");
    });
    const visibilityChanged = () => {
      if (document.visibilityState === "visible" && cloudConfigured) syncInBackground();
    };
    const intervalId = window.setInterval(() => {
      if (cloudConfigured && navigator.onLine) syncInBackground();
    }, 8000);
    window.addEventListener("online", syncInBackground);
    document.addEventListener("visibilitychange", visibilityChanged);
    if (cloudConfigured) syncInBackground();
    return () => {
      window.clearTimeout(initialRefreshId);
      window.clearInterval(intervalId);
      window.removeEventListener("pacman-queue-change", refreshQueue);
      window.removeEventListener("online", syncInBackground);
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, [refreshQueue]);

  useEffect(() => {
    const fullscreenChanged = () => {
      setIsFullscreen(document.fullscreenElement === workspaceRef.current);
    };
    document.addEventListener("fullscreenchange", fullscreenChanged);
    return () => document.removeEventListener("fullscreenchange", fullscreenChanged);
  }, []);

  const setDirection = useCallback((direction: Direction) => {
    const game = gameRef.current;
    if (!game || game.ended || pausedRef.current) return;
    game.queuedDirection = direction;
    game.inputAttempts += 1;
    if (game.firstActionAt === null) {
      game.firstActionAt = Math.max(performance.now(), game.readyUntil) - game.totalPausedMs;
    }
  }, []);

  const togglePause = useCallback(() => {
    const game = gameRef.current;
    if (!game || game.ended || screen !== "playing") return;
    const now = performance.now();
    if (!pausedRef.current) {
      pausedRef.current = true;
      game.pausedAt = now;
      setPaused(true);
      return;
    }
    const pausedFor = Math.max(0, now - (game.pausedAt ?? now));
    game.totalPausedMs += pausedFor;
    if (game.frozenUntil > 0) game.frozenUntil += pausedFor;
    if (game.readyUntil > game.pausedAt!) game.readyUntil += pausedFor;
    if (game.playerSafeUntil > game.pausedAt!) game.playerSafeUntil += pausedFor;
    game.ghosts.forEach((ghost) => {
      if (ghost.respawningUntil > (game.pausedAt ?? now)) ghost.respawningUntil += pausedFor;
    });
    game.pausedAt = null;
    game.lastPlayerMove = now;
    game.lastGhostMove = now;
    pausedRef.current = false;
    setPaused(false);
  }, [screen]);

  const closeMobilePlayPrompt = useCallback(() => {
    setShowMobilePlayPrompt(false);
    setFullscreenError("");
    if (pausedRef.current) togglePause();
  }, [togglePause]);

  const enterFullscreen = useCallback(async () => {
    const workspace = workspaceRef.current;
    if (!workspace || !document.fullscreenEnabled) {
      setFullscreenError("Full screen is unavailable in this browser. Rotate your phone and continue normally.");
      return;
    }
    try {
      await workspace.requestFullscreen({ navigationUI: "hide" });
      setIsFullscreen(true);
      if (showMobilePlayPrompt) closeMobilePlayPrompt();
    } catch {
      setFullscreenError("Full screen could not start. Rotate your phone and continue normally.");
    }
  }, [closeMobilePlayPrompt, showMobilePlayPrompt]);

  const exitFullscreen = useCallback(async () => {
    if (!document.fullscreenElement) return;
    try {
      await document.exitFullscreen();
    } catch {
      setFullscreenError("Use your browser's back or full-screen control to exit.");
    }
  }, []);

  const startPreferredMobileMode = useCallback(async () => {
    if (preferFullscreen) {
      await enterFullscreen();
      return;
    }
    closeMobilePlayPrompt();
  }, [closeMobilePlayPrompt, enterFullscreen, preferFullscreen]);

  const startSwipe = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    swipeStartRef.current = { row: event.clientY, col: event.clientX };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);

  const finishSwipe = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    const start = swipeStartRef.current;
    swipeStartRef.current = null;
    if (!start) return;
    const deltaX = event.clientX - start.col;
    const deltaY = event.clientY - start.row;
    if (Math.max(Math.abs(deltaX), Math.abs(deltaY)) < 18) return;
    if (Math.abs(deltaX) > Math.abs(deltaY)) setDirection(deltaX > 0 ? "right" : "left");
    else setDirection(deltaY > 0 ? "down" : "up");
  }, [setDirection]);

  const savePendingRound = useCallback(async (feedback: Feedback) => {
    const pending = pendingRecordRef.current;
    if (!pending) return;
    const implicitTarget: -1 | 0 | 1 = pending.retries >= 3 || pending.accuracy < 85
      ? -1
      : pending.retries === 0 && pending.accuracy >= 97 && pending.elapsed_time_ratio < 0.8 ? 1 : 0;
    const trusted = feedback !== "skipped";
    const trustedTarget: -1 | 0 | 1 = feedback === "too_difficult"
      ? -1
      : feedback === "too_easy" ? 1 : 0;
    const record: RoundRecord = {
      ...pending,
      target_adjustment: trusted ? trustedTarget : implicitTarget,
      player_feedback: feedback,
      label_source: trusted ? "player_feedback" : "implicit_real_outcome",
      label_confidence: trusted ? 1 : 0.65,
    };
    pendingRecordRef.current = null;
    await submitRound(record);
    refreshQueue();
    setResult({
      title: record.outcome === "completed" ? `Round ${record.level} complete` : `Round ${record.level} recorded`,
      detail: `${record.difficulty} | score ${record.score} | ${record.retries} retries | ${trusted ? "feedback saved" : "implicit label saved"}`,
    });
    setScreen("round_result");
  }, [refreshQueue]);

  const finishRound = useCallback((outcome: "completed" | "failed" | "abandoned") => {
    const game = gameRef.current;
    if (!game || game.ended) return;
    game.ended = true;
    const elapsed = Math.max(0.01, (performance.now() - game.startedAt - game.totalPausedMs) / 1000);
    const collected = game.initialCollectibles - game.dots.size - game.power.size;
    const progressRate = Math.max(0, Math.min(1, collected / game.initialCollectibles));
    const accuracy = game.score + game.errors * 10 > 0 ? game.score / (game.score + game.errors * 10) * 100 : 100;
    pendingRecordRef.current = {
      id: game.roundId,
      session_id: sessionRef.current,
      participant_id: participantRef.current,
      level: game.level,
      difficulty: game.difficulty,
      difficulty_factor: DIFFICULTY_FACTOR[game.difficulty],
      outcome,
      reaction_time: Number((((game.firstActionAt ?? performance.now() - game.totalPausedMs) - game.startedAt) / 1000).toFixed(3)),
      completion_time: Number(elapsed.toFixed(3)),
      score: game.score,
      retries: game.retries,
      accuracy: Number(accuracy.toFixed(3)),
      errors: game.errors,
      actions_taken: game.actions,
      elapsed_time_ratio: Number((elapsed / (EXPECTED_SECONDS[game.difficulty] + (game.level - 1) * 12)).toFixed(6)),
      progress_rate: Number(progressRate.toFixed(6)),
      score_rate: Number((game.score / elapsed).toFixed(6)),
      action_rate: Number((game.actions / elapsed).toFixed(6)),
      idle_ratio: Number((game.idleTicks / Math.max(1, game.movementTicks)).toFixed(6)),
      direction_change_rate: Number((game.directionChanges / Math.max(1, game.actions - 1)).toFixed(6)),
      validation_status: "pending_validation",
      source_dataset: "web_pacman",
      client_version: CLIENT_VERSION,
    };
    if (game.level % 2 === 0) setScreen("feedback");
    else void savePendingRound("skipped");
  }, [savePendingRound]);

  useEffect(() => {
    if (screen !== "playing") return;
    let frameId = 0;
    const keydown = (event: KeyboardEvent) => {
      const map: Record<string, Direction> = { ArrowUp: "up", w: "up", ArrowDown: "down", s: "down", ArrowLeft: "left", a: "left", ArrowRight: "right", d: "right" };
      if (event.key.toLowerCase() === "p") { event.preventDefault(); togglePause(); return; }
      const direction = map[event.key];
      if (direction) { event.preventDefault(); setDirection(direction); }
    };
    window.addEventListener("keydown", keydown, { passive: false });
    if (paused) {
      if (canvasRef.current && gameRef.current) drawGame(canvasRef.current, gameRef.current);
      return () => window.removeEventListener("keydown", keydown);
    }

    const moveGhost = (game: GameState, ghost: Ghost, now: number) => {
      if (now < ghost.respawningUntil) return;
      const choices = (Object.values(vectors) as Point[])
        .map((vector) => ({ row: ghost.row + vector.row, col: ghost.col + vector.col }))
        .filter((point) => isOpen(game.maze, point));
      const unoccupied = choices.filter((point) => !game.ghosts.some((other) =>
        other !== ghost && now >= other.respawningUntil && other.row === point.row && other.col === point.col,
      ));
      const available = unoccupied.length > 0 ? unoccupied : choices;
      const nearbyGhosts = game.ghosts.filter((other) =>
        now >= other.respawningUntil && Math.abs(other.row - game.player.row) + Math.abs(other.col - game.player.col) <= 4,
      ).length;
      const baseChase = game.difficulty === "Easy" ? 0.32 : game.difficulty === "Medium" ? 0.55 : 0.74;
      const chase = nearbyGhosts >= 2 ? baseChase * 0.48 : baseChase;
      const choice = Math.random() < chase
        ? available.sort((a, b) => (Math.abs(a.row - game.player.row) + Math.abs(a.col - game.player.col)) - (Math.abs(b.row - game.player.row) + Math.abs(b.col - game.player.col)))[0]
        : available[Math.floor(Math.random() * available.length)];
      if (choice) { ghost.row = choice.row; ghost.col = choice.col; }
    };
    const collision = (game: GameState, now: number) => {
      for (const ghost of game.ghosts) {
        if (now < ghost.respawningUntil) continue;
        if (ghost.row !== game.player.row || ghost.col !== game.player.col) continue;
        if (now < game.frozenUntil) {
          const reward = 200 * Math.min(8, 2 ** game.ghostCombo);
          game.score += reward;
          game.ghostCombo += 1;
          game.ghostsEaten += 1;
          ghost.eaten += 1;
          ghost.row = ghost.spawn.row; ghost.col = ghost.spawn.col;
          ghost.respawningUntil = Math.max(now + 1800, game.frozenUntil + 600);
        } else if (now >= game.playerSafeUntil) {
          game.retries += 1; game.errors += 1;
          game.player = { row: 1, col: 1 };
          game.direction = null; game.queuedDirection = null;
          game.ghostCombo = 0;
          game.readyUntil = now + 1100;
          game.playerSafeUntil = now + 2200;
          game.ghosts.forEach((item) => {
            item.row = item.spawn.row;
            item.col = item.spawn.col;
            item.respawningUntil = 0;
          });
          if (game.retries >= MAX_RETRIES) finishRound("failed");
        }
        break;
      }
    };
    const animate = (timestamp: number) => {
      const game = gameRef.current;
      if (!game || game.ended) return;
      const playerDelay = game.difficulty === "Hard" ? 112 : 102;
      const ghostDelay = game.difficulty === "Easy" ? 420 : game.difficulty === "Medium" ? 300 : 220;
      if (timestamp >= game.frozenUntil) game.ghostCombo = 0;
      if (timestamp >= game.readyUntil && timestamp - game.lastPlayerMove >= playerDelay) {
        game.lastPlayerMove = timestamp; game.movementTicks += 1;
        const desired = game.queuedDirection ?? game.direction;
        if (desired) {
          const vector = vectors[desired];
          const next = { row: game.player.row + vector.row, col: game.player.col + vector.col };
          if (isOpen(game.maze, next)) {
            if (game.lastDirection && game.lastDirection !== desired) game.directionChanges += 1;
            game.lastDirection = desired; game.direction = desired; game.player = next; game.actions += 1;
            const key = pointKey(next);
            if (game.dots.delete(key)) game.score += 10;
            if (game.power.delete(key)) {
              const freezeDuration = game.difficulty === "Easy" ? 6000 : game.difficulty === "Medium" ? 5200 : 4500;
              game.score += 50;
              game.frozenUntil = timestamp + freezeDuration;
              game.ghostCombo = 0;
            }
          } else game.idleTicks += 1;
        } else game.idleTicks += 1;
      }
      if (timestamp >= game.readyUntil && timestamp - game.lastGhostMove >= ghostDelay && timestamp >= game.frozenUntil) {
        game.lastGhostMove = timestamp; game.ghosts.forEach((ghost) => moveGhost(game, ghost, timestamp));
      }
      if (timestamp >= game.readyUntil) collision(game, timestamp);
      if (!game.ended && game.dots.size === 0 && game.power.size === 0) finishRound("completed");
      if (canvasRef.current) drawGame(canvasRef.current, game, timestamp);
      if (timestamp - game.lastHudUpdate >= 100) {
        game.lastHudUpdate = timestamp;
        setHud({ score: game.score, retries: game.retries, remaining: game.dots.size + game.power.size, ghostsEaten: game.ghostsEaten });
      }
      frameId = requestAnimationFrame(animate);
    };
    frameId = requestAnimationFrame(animate);
    return () => { cancelAnimationFrame(frameId); window.removeEventListener("keydown", keydown); };
  }, [finishRound, paused, screen, setDirection, togglePause]);

  const beginRound = useCallback((nextLevel: number) => {
    const nextDifficulty = difficultyFor(startDifficultyRef.current, nextLevel);
    gameRef.current = createGame(nextLevel, nextDifficulty);
    const shouldOfferMobileFullscreen = nextLevel === 1 && !document.fullscreenElement;
    pausedRef.current = shouldOfferMobileFullscreen;
    gameRef.current.pausedAt = shouldOfferMobileFullscreen ? performance.now() : null;
    setPaused(shouldOfferMobileFullscreen);
    setShowMobilePlayPrompt(shouldOfferMobileFullscreen);
    setFullscreenError("");
    setLevel(nextLevel); setDifficulty(nextDifficulty);
    setHud({ score: 0, retries: 0, remaining: gameRef.current.initialCollectibles, ghostsEaten: 0 });
    setScreen("playing");
  }, []);

  const startSession = async () => {
    const code = participantCode.trim();
    if (code.length < 2 || !consent) return;
    participantRef.current = participantIdFor(code);
    sessionRef.current = crypto.randomUUID();
    startDifficultyRef.current = difficultyStart(code + sessionRef.current.slice(-4));
    const initialDifficulty = difficultyFor(startDifficultyRef.current, 1);
    await submitSession({
      id: sessionRef.current,
      participant_id: participantRef.current,
      initial_difficulty: initialDifficulty,
      rounds_planned: MAX_LEVELS,
      consent_version: CONSENT_VERSION,
      client_version: CLIENT_VERSION,
      source_dataset: "web_pacman",
    });
    refreshQueue();
    beginRound(1);
  };

  const advance = () => {
    if (level >= MAX_LEVELS) {
      setCompletedSessions((count) => count + 1);
      setScreen("session_complete");
    }
    else beginRound(level + 1);
  };

  const sendWrittenFeedback = async () => {
    const message = sessionComment.trim();
    if (!message || feedbackSubmitting || feedbackSent) return;
    setFeedbackSubmitting(true);
    await submitSessionFeedback({
      id: crypto.randomUUID(),
      session_id: sessionRef.current,
      participant_id: participantRef.current,
      message,
      client_version: CLIENT_VERSION,
      source_dataset: "web_pacman",
    });
    refreshQueue();
    setFeedbackSubmitting(false);
    setFeedbackSent(true);
  };

  const playAgain = async () => {
    setSessionComment("");
    setFeedbackSent(false);
    await startSession();
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <span className="pac-mark" aria-hidden="true"><i /></span>
          <div>
            <p className="eyebrow">Dynamic Difficulty Research</p>
            <h1>Pac-Man Player Study</h1>
          </div>
        </div>
        <div className="sync-cluster" aria-live="polite">
          <span className={`status-dot ${cloudConfigured ? "online" : "local"}`} />
          <div><strong>{syncText}</strong><small>{pendingCount} pending records</small></div>
        </div>
      </header>

      {screen === "profile" && (
        <section className="profile-screen">
          <div className="profile-copy">
            <span className="round-mark">5 rounds</span>
            <h2>Play naturally. Rate the challenge.</h2>
            <p>Your anonymous movement, timing, errors, score, and difficulty feedback help train the final adaptive model.</p>
            <ul><li>No account or email required</li><li>About 5-8 minutes per session</li><li>Play 2-4 sessions for 10-20 total rounds</li></ul>
          </div>
          <form className="profile-form" onSubmit={(event) => { event.preventDefault(); void startSession(); }}>
            <label htmlFor="participant">Participant code</label>
            <input id="participant" value={participantCode} onChange={(event) => setParticipantCode(event.target.value)} maxLength={24} placeholder="Example: FRIEND07" autoComplete="off" />
            <label className="consent-row"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} /><span>I agree to share anonymous gameplay metrics for this university project.</span></label>
            <button className="primary-button" disabled={participantCode.trim().length < 2 || !consent}>Start session</button>
          </form>
        </section>
      )}

      {screen !== "profile" && screen !== "session_complete" && (
        <section ref={workspaceRef} className={`game-workspace${isFullscreen ? " is-fullscreen" : ""}`}>
          <div className="metrics-bar">
            <div><span>Round</span><strong>{level}/{MAX_LEVELS}</strong></div>
            <div><span>Difficulty</span><strong className={`difficulty ${difficulty.toLowerCase()}`}>{difficulty}</strong></div>
            <div><span>Score</span><strong>{hud.score}</strong></div>
            <div><span>Retries</span><strong>{hud.retries}/{MAX_RETRIES}</strong></div>
            <div><span>Remaining</span><strong>{hud.remaining}</strong></div>
            <div><span>Ghosts eaten</span><strong>{hud.ghostsEaten}</strong></div>
          </div>
          <div className="canvas-stage">
            <button
              className="fullscreen-toggle"
              onClick={() => void (isFullscreen ? exitFullscreen() : enterFullscreen())}
              aria-label={isFullscreen ? "Exit full screen" : "Open game in full screen"}
              title={isFullscreen ? "Exit full screen" : "Full screen"}
            ><span aria-hidden="true">⛶</span><span>{isFullscreen ? "Exit" : "Full screen"}</span></button>
            <button
              className="pause-toggle"
              onClick={togglePause}
              aria-label={paused ? "Resume game" : "Pause game"}
              title={paused ? "Resume game" : "Pause game"}
            >{paused ? "▶" : "Ⅱ"}</button>
            <canvas
              ref={canvasRef}
              width={960}
              height={640}
              aria-label="Pac-Man game board. Swipe to change direction."
              onPointerDown={startSwipe}
              onPointerUp={finishSwipe}
              onPointerCancel={() => { swipeStartRef.current = null; }}
              onContextMenu={(event) => event.preventDefault()}
            />
            {paused && !showMobilePlayPrompt && (
              <div className="pause-overlay" role="status">
                <p className="eyebrow">Game paused</p>
                <h2>Ready when you are.</h2>
                <button className="primary-button" onClick={togglePause}>▶ Resume</button>
              </div>
            )}
            {showMobilePlayPrompt && (
              <div className="play-mode-prompt" role="dialog" aria-modal="true" aria-labelledby="play-mode-title">
                <p className="eyebrow">Play setup</p>
                <h2 id="play-mode-title">Choose your game view</h2>
                <p>Rotate your phone sideways for the clearest maze view. Full screen keeps only the board, compact score, and controls.</p>
                <label className="fullscreen-preference">
                  <span><strong>Full screen</strong><small>Recommended for mobile</small></span>
                  <input
                    type="checkbox"
                    role="switch"
                    checked={preferFullscreen}
                    onChange={(event) => {
                      setPreferFullscreen(event.target.checked);
                      setFullscreenError("");
                    }}
                  />
                </label>
                {fullscreenError && <p className="fullscreen-error" role="alert">{fullscreenError}</p>}
                <button className="primary-button" onClick={() => void startPreferredMobileMode()}>
                  {preferFullscreen ? "⛶ Start in full screen" : "Start normally"}
                </button>
              </div>
            )}
            {screen === "feedback" && (
              <div className="overlay-panel feedback-panel">
                <p className="eyebrow">Round feedback</p><h2>How did that round feel?</h2>
                <div className="feedback-actions">
                  <button onClick={() => void savePendingRound("too_difficult")}>Too difficult</button>
                  <button onClick={() => void savePendingRound("balanced")}>Balanced</button>
                  <button onClick={() => void savePendingRound("too_easy")}>Too easy</button>
                </div>
                <button className="text-button" onClick={() => void savePendingRound("skipped")}>Skip feedback</button>
              </div>
            )}
            {screen === "round_result" && (
              <div className="overlay-panel result-panel">
                <p className="eyebrow">Record accepted</p><h2>{result.title}</h2><p>{result.detail}</p>
                <button className="primary-button" onClick={advance}>{level >= MAX_LEVELS ? "Finish session" : "Start next round"}</button>
              </div>
            )}
          </div>
          <div className="controls-row">
            <span className="desktop-control-hint">Arrow keys or WASD</span>
            <div className="dpad" aria-label="Touch movement controls">
              <button disabled={paused} className="up" onPointerDown={() => setDirection("up")} aria-label="Move up">↑</button>
              <button disabled={paused} className="left" onPointerDown={() => setDirection("left")} aria-label="Move left">←</button>
              <button disabled={paused} className="down" onPointerDown={() => setDirection("down")} aria-label="Move down">↓</button>
              <button disabled={paused} className="right" onPointerDown={() => setDirection("right")} aria-label="Move right">→</button>
            </div>
            <span className="power-hint">Swipe board or use controls</span>
          </div>
        </section>
      )}

      {screen === "session_complete" && (
        <section className="complete-screen">
          <span className="complete-pac" aria-hidden="true" />
          <p className="eyebrow">Session complete</p>
          <h2>{completedSessions % 2 === 1 ? "thankz cuddh..much love" : "means a lot...<3"}</h2>
          <div className="session-note">
            <div className="session-note-heading">
              <label htmlFor="session-comment">Leave a note</label>
              <span>Optional · {sessionComment.length}/1000</span>
            </div>
            <textarea
              id="session-comment"
              rows={4}
              maxLength={1000}
              value={sessionComment}
              disabled={feedbackSent}
              onChange={(event) => {
                setSessionComment(event.target.value);
                setFeedbackSent(false);
              }}
              placeholder="Anything about the maze, controls, difficulty, or overall feel?"
            />
            <div className="session-note-actions">
              <span aria-live="polite">{feedbackSent ? "Feedback sent" : ""}</span>
              <button
                className="secondary-button"
                disabled={!sessionComment.trim() || feedbackSubmitting || feedbackSent}
                onClick={() => void sendWrittenFeedback()}
              >{feedbackSubmitting ? "Sending..." : "Send"}</button>
            </div>
          </div>
          <div className="complete-actions">
            <button className="primary-button" onClick={() => void playAgain()}>Play again</button>
          </div>
        </section>
      )}

      <footer><span>Anonymous research build {CLIENT_VERSION}</span><span>Data source: web_pacman</span></footer>
    </main>
  );
}
