'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';

type HandRole = 'pink' | 'blue';

type FallingBall = {
  id: number;
  x: number;
  y: number;
  radius: number;
  speed: number;
  role: HandRole;
  active: boolean;
};

type TrackedHand = {
  role: HandRole;
  handednessLabel: 'Left' | 'Right' | 'Unknown';
  points: { x: number; y: number }[];
  palmCenter: { x: number; y: number };
  fingertip: { x: number; y: number };
};


const HAND_CONNECTIONS: Array<[number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

const ROLE_COLORS: Record<HandRole, string> = {
  pink: '#ff4db8',
  blue: '#32c8ff',
};

const BG_GRADIENT = ['#0b1020', '#10182f', '#182341'];
const MAX_BALLS = 8;
const SPAWN_INTERVAL_MS = 900;
const SCORE_PER_CATCH = 10;
const HIT_RADIUS = 18;
const MAX_MISSES = 5;
const RANKING_STORAGE_KEY = 'hand-color-catch-ranking';

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function distance(ax: number, ay: number, bx: number, by: number) {
  return Math.hypot(ax - bx, ay - by);
}

function makeBall(id: number, width: number): FallingBall {
  const role: HandRole = Math.random() > 0.5 ? 'pink' : 'blue';
  const margin = 60;
  return {
    id,
    x: margin + Math.random() * Math.max(1, width - margin * 2),
    y: -30,
    radius: 18 + Math.random() * 10,
    speed: 2.2 + Math.random() * 1.8,
    role,
    active: true,
  };
}

function getRoleFromHandedness(label: string | undefined): HandRole {
  // Webcam preview is usually mirrored, so MediaPipe's handedness can feel inverted on screen.
  // This mapping keeps the gameplay visually intuitive in a mirrored selfie view:
  // screen-left hand => one color, screen-right hand => another color.
  // If you want strict anatomical mapping later, swap this function.
  if (label === 'Left') return 'pink';
  return 'blue';
}

export default function HandColorCatchGame() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const handLandmarkerRef = useRef<HandLandmarker | null>(null);
  const animationRef = useRef<number | null>(null);
  const lastVideoTimeRef = useRef(-1);
  const trackedHandsRef = useRef<TrackedHand[]>([]);
  const ballsRef = useRef<FallingBall[]>([]);
  const particlesRef = useRef<{ x: number; y: number; vx: number; vy: number; life: number; color: string }[]>([]);
  const ballIdRef = useRef(0);
  const lastSpawnTimeRef = useRef(0);
  const scoreRef = useRef(0);
  const missesRef = useRef(0);

  const [score, setScore] = useState(0);
  const [misses, setMisses] = useState(0);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string>('');

  const gameStateRef = useRef<'INPUT' | 'PLAYING' | 'GAME_OVER'>('INPUT');
  const [gameState, setGameState] = useState<'INPUT' | 'PLAYING' | 'GAME_OVER'>('INPUT');

  const changeGameState = (newState: 'INPUT' | 'PLAYING' | 'GAME_OVER') => {
    gameStateRef.current = newState;
    setGameState(newState);
  };

  const [playerName, setPlayerName] = useState('');
  const [ranking, setRanking] = useState<Array<{ name: string; score: number; date: string }>>([]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(RANKING_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) setRanking(parsed);
    } catch (e) {
      console.error('Failed to load ranking:', e);
    }
  }, []);

  const legend = useMemo(
    () => [
      { role: 'pink' as HandRole, label: '핑크 공은 핑크 손만 잡기' },
      { role: 'blue' as HandRole, label: '블루 공은 블루 손만 잡기' },
    ],
    []
  );

  useEffect(() => {
    let stream: MediaStream | null = null;
    let mounted = true;

    async function setup() {
      try {
        const video = videoRef.current;
        const canvas = canvasRef.current;
        if (!video || !canvas) return;

        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 1280 },
            height: { ideal: 720 },
            facingMode: 'user',
          },
          audio: false,
        });

        video.srcObject = stream;
        await video.play();

        const vision = await FilesetResolver.forVisionTasks(
          'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm'
        );

        const handLandmarker = await HandLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath:
              'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
          },
          runningMode: 'VIDEO',
          numHands: 2,
          minHandDetectionConfidence: 0.5,
          minHandPresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
        });

        handLandmarkerRef.current = handLandmarker;
        if (!mounted) return;
        setReady(true);
        startLoop();
      } catch (e) {
        console.error(e);
        setError('웹캠 또는 손 인식 초기화에 실패했습니다. 브라우저 권한과 패키지 설치 상태를 확인해주세요.');
      }
    }

    function startLoop() {
      const loop = () => {
        renderFrame();
        animationRef.current = requestAnimationFrame(loop);
      };
      animationRef.current = requestAnimationFrame(loop);
    }

    setup();

    return () => {
      mounted = false;
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
      }
      handLandmarkerRef.current?.close();
      handLandmarkerRef.current = null;
    };
  }, []);

  const renderFrame = () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const handLandmarker = handLandmarkerRef.current;
    if (!video || !canvas || !handLandmarker) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = video.videoWidth || 1280;
    const height = video.videoHeight || 720;

    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;

    ctx.clearRect(0, 0, width, height);

    // Webcam image (mirrored for selfie-like interaction)
    ctx.save();
    ctx.translate(width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, width, height);
    ctx.restore();

    drawBackdrop(ctx, width, height);

    const nowMs = performance.now();
    const nowVideoTime = video.currentTime;

    if (nowVideoTime !== lastVideoTimeRef.current) {
      lastVideoTimeRef.current = nowVideoTime;
      const result = handLandmarker.detectForVideo(video, nowMs);
      trackedHandsRef.current = mapHands(result, width, height);
    }

    spawnBallsIfNeeded(width, nowMs);
    updateBalls(height);
    resolveCollisions();
    drawBalls(ctx);
    drawParticles(ctx);
    drawHands(ctx);
    drawHud(ctx, width);
    if (gameStateRef.current === 'GAME_OVER') {
      drawGameOver(ctx, width, height);
    }
  };

  const mapHands = (result: any, width: number, height: number): TrackedHand[] => {
    const landmarks = result?.landmarks ?? [];
    const handednesses = result?.handednesses ?? [];

    return landmarks.map((hand: any, index: number) => {
      const label = handednesses?.[index]?.[0]?.categoryName ?? 'Unknown';
      const role = getRoleFromHandedness(label);

      const points = hand.map((p: any) => ({
        x: width - p.x * width,
        y: p.y * height,
      }));

      const wrist = points[0];
      const indexMcp = points[5];
      const middleMcp = points[9];
      const ringMcp = points[13];
      const pinkyMcp = points[17];
      const fingertip = points[8];

      const palmCenter = {
        x: (wrist.x + indexMcp.x + middleMcp.x + ringMcp.x + pinkyMcp.x) / 5,
        y: (wrist.y + indexMcp.y + middleMcp.y + ringMcp.y + pinkyMcp.y) / 5,
      };

      return {
        role,
        handednessLabel: label,
        points,
        palmCenter,
        fingertip,
      };
    });
  };

  const spawnBallsIfNeeded = (width: number, nowMs: number) => {
    if (gameStateRef.current !== 'PLAYING') return;
    if (ballsRef.current.filter((ball) => ball.active).length >= MAX_BALLS) return;
    if (nowMs - lastSpawnTimeRef.current < SPAWN_INTERVAL_MS) return;

    lastSpawnTimeRef.current = nowMs;
    ballsRef.current.push(makeBall(ballIdRef.current++, width));
  };

  const updateBalls = (height: number) => {
    ballsRef.current = ballsRef.current
      .map((ball) => {
        if (!ball.active) return ball;
        return { ...ball, y: ball.y + ball.speed };
      })
      .filter((ball) => {
        if (!ball.active) return false;
        if (ball.y - ball.radius > height + 10) {
          missesRef.current += 1;
          setMisses(missesRef.current);
          if (missesRef.current >= MAX_MISSES && gameStateRef.current === 'PLAYING') {
            changeGameState('GAME_OVER');
            ballsRef.current = [];
            // Auto-save the score
            saveRanking(scoreRef.current);
          }
          return false;
        }
        return true;
      });
  };

  const resolveCollisions = () => {
    if (gameStateRef.current !== 'PLAYING') return;
    const hands = trackedHandsRef.current;

    ballsRef.current = ballsRef.current.filter((ball) => {
      if (!ball.active) return false;

      const matchedHand = hands.find((hand) => hand.role === ball.role);
      if (!matchedHand) return true;

      const hit =
        distance(ball.x, ball.y, matchedHand.fingertip.x, matchedHand.fingertip.y) <=
        ball.radius + HIT_RADIUS;

      if (hit) {
        scoreRef.current += SCORE_PER_CATCH;
        setScore(scoreRef.current);

        // spawn particles effect
        for (let i = 0; i < 12; i++) {
          const angle = Math.random() * Math.PI * 2;
          const speed = 2 + Math.random() * 3;
          particlesRef.current.push({
            x: ball.x,
            y: ball.y,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed,
            life: 30,
            color: ROLE_COLORS[ball.role],
          });
        }

        return false;
      }

      return true;
    });
  };

  const drawBackdrop = (ctx: CanvasRenderingContext2D, width: number, height: number) => {
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, 'rgba(11,16,32,0.18)');
    gradient.addColorStop(0.4, 'rgba(16,24,47,0.08)');
    gradient.addColorStop(1, 'rgba(24,35,65,0.18)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    for (let y = 0; y < height; y += 80) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
  };

  const drawHands = (ctx: CanvasRenderingContext2D) => {
    trackedHandsRef.current.forEach((hand) => {
      const color = ROLE_COLORS[hand.role];

      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = 4;
      ctx.shadowColor = color;
      ctx.shadowBlur = 12;

      HAND_CONNECTIONS.forEach(([from, to]) => {
        const a = hand.points[from];
        const b = hand.points[to];
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      });

      ctx.fillStyle = color;
      hand.points.forEach((point, index) => {
        ctx.beginPath();
        ctx.arc(point.x, point.y, index === 8 ? 8 : 6, 0, Math.PI * 2);
        ctx.fill();
      });

      // Index fingertip-only hit area.
      ctx.beginPath();
      ctx.arc(hand.fingertip.x, hand.fingertip.y, HIT_RADIUS, 0, Math.PI * 2);
      ctx.strokeStyle = `${color}66`;
      ctx.lineWidth = 2;
      ctx.shadowBlur = 0;
      ctx.stroke();

      ctx.restore();
    });
  };

  const drawBalls = (ctx: CanvasRenderingContext2D) => {
    ballsRef.current.forEach((ball) => {
      const color = ROLE_COLORS[ball.role];
      const glow = ctx.createRadialGradient(ball.x, ball.y, 4, ball.x, ball.y, ball.radius * 2.4);
      glow.addColorStop(0, 'rgba(255,255,255,0.95)');
      glow.addColorStop(0.2, color);
      glow.addColorStop(1, 'rgba(255,255,255,0)');

      ctx.save();
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(ball.x, ball.y, ball.radius * 2.4, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(ball.x, ball.y, ball.radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    });
  };

  const drawParticles = (ctx: CanvasRenderingContext2D) => {
    particlesRef.current = particlesRef.current
      .map((p) => ({ ...p, x: p.x + p.vx, y: p.y + p.vy, life: p.life - 1 }))
      .filter((p) => p.life > 0);

    particlesRef.current.forEach((p) => {
      ctx.save();
      ctx.globalAlpha = p.life / 30;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    });
  };

  const playerNameRef = useRef('');
  useEffect(() => {
    playerNameRef.current = playerName;
  }, [playerName]);

  const drawHud = (ctx: CanvasRenderingContext2D, width: number) => {
    const hudWidth = 360;
    const hudHeight = 70;
    const x = width / 2 - hudWidth / 2;
    const y = 18;

    ctx.save();
    const panel = ctx.createLinearGradient(x, y, x, y + hudHeight);
    panel.addColorStop(0, 'rgba(26,30,45,0.92)');
    panel.addColorStop(1, 'rgba(40,46,69,0.86)');

    roundRect(ctx, x, y, hudWidth, hudHeight, 22);
    ctx.fillStyle = panel;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.font = '700 18px Inter, sans-serif';
    ctx.fillText('SCORE', x + 34, y + 28);
    ctx.fillStyle = '#7ff0ff';
    ctx.font = '800 34px Inter, sans-serif';
    ctx.fillText(String(scoreRef.current).padStart(3, '0'), x + 110, y + 40);

    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.beginPath();
    ctx.moveTo(x + 210, y + 14);
    ctx.lineTo(x + 210, y + hudHeight - 14);
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.font = '700 18px Inter, sans-serif';
    ctx.fillText('MISS', x + 236, y + 28);
    ctx.fillStyle = missesRef.current >= MAX_MISSES ? '#ff4d6d' : '#ff8fa8';
    ctx.font = '800 28px Inter, sans-serif';
    ctx.fillText(`${missesRef.current}/${MAX_MISSES}`, x + 280, y + 55);
    ctx.restore();
  };

  const drawGameOver = (ctx: CanvasRenderingContext2D, width: number, height: number) => {
    ctx.save();
    ctx.fillStyle = 'rgba(3, 6, 15, 0.66)';
    ctx.fillRect(0, 0, width, height);

    const boxW = 420;
    const boxH = 180;
    const x = width / 2 - boxW / 2;
    const y = height / 2 - boxH / 2;

    roundRect(ctx, x, y, boxW, boxH, 28);
    ctx.fillStyle = 'rgba(20, 24, 39, 0.96)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = '#ff7b93';
    ctx.font = '800 34px Inter, sans-serif';
    ctx.fillText('GAME OVER', x + 110, y + 58);

    ctx.fillStyle = '#ffffff';
    ctx.font = '600 20px Inter, sans-serif';
    ctx.fillText(`Final Score: ${scoreRef.current}`, x + 128, y + 100);

    ctx.fillStyle = 'rgba(255,255,255,0.72)';
    ctx.font = '500 16px Inter, sans-serif';
    ctx.fillText('우측 하단의 Restart 버튼을 누르세요.', x + 82, y + 136);
    ctx.restore();
  };

  const saveRanking = (finalScore: number) => {
    setRanking((prev) => {
      const trimmedName = playerNameRef.current.trim() || 'PLAYER';
      const next = [
        { name: trimmedName.slice(0, 12), score: finalScore, date: new Date().toLocaleDateString() },
        ...prev,
      ]
        .sort((a, b) => b.score - a.score)
        .slice(0, 10);

      localStorage.setItem(RANKING_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  };

  const restartGame = () => {
    ballsRef.current = [];
    particlesRef.current = [];
    trackedHandsRef.current = [];
    scoreRef.current = 0;
    missesRef.current = 0;
    lastSpawnTimeRef.current = 0;
    setScore(0);
    setMisses(0);
    changeGameState('INPUT');
  };

  const startGame = () => {
    if (!playerName.trim()) return;
    changeGameState('PLAYING');
  };

  return (
    <main className="min-h-screen bg-[#060b16] font-sans text-white selection:bg-[#ff4db8]/30">

      {/* 1. INPUT Screen */}
      {gameState === 'INPUT' && (
        <div className="flex min-h-screen flex-col items-center justify-center p-6 bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-blue-900/20 via-[#060b16] to-[#060b16]">
          <div className="w-full max-w-sm rounded-[32px] border border-white/10 bg-[#0c1220] p-10 shadow-[0_0_60px_-15px_rgba(46,214,255,0.3)] backdrop-blur-xl transition-all duration-700 hover:border-cyan-400/30">
            <div className="mb-2 flex justify-center">
              <span className="inline-block h-3 w-3 rounded-full bg-[#ff4db8] shadow-[0_0_10px_#ff4db8] mt-2 mr-3" />
              <span className="inline-block h-3 w-3 rounded-full bg-cyan-400 shadow-[0_0_10px_#2ed6ff] mt-2 mr-3" />
            </div>
            <h1 className="mb-3 text-center text-4xl font-extrabold tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-[#ff4db8] to-[#32c8ff]">
              Color Catch
            </h1>
            <p className="mb-8 text-center text-sm font-medium text-white/50">
              게임에 쓸 닉네임을 적고 시작하세요.
            </p>

            <input
              value={playerName}
              onChange={(e) => setPlayerName(e.target.value)}
              maxLength={12}
              className="mb-5 w-full rounded-2xl border border-white/10 bg-black/40 px-5 py-4 text-center text-lg font-bold text-white shadow-inner outline-none transition-all placeholder:text-white/20 focus:border-cyan-400/50 focus:ring-1 focus:ring-cyan-400/50"
              placeholder="닉네임 입력 (12자 이내)"
              onKeyDown={(e) => {
                if (e.key === 'Enter') startGame();
              }}
            />

            <button
              onClick={startGame}
              disabled={!playerName.trim()}
              className="w-full rounded-2xl bg-gradient-to-r from-cyan-500 to-[#32c8ff] px-5 py-4 text-lg font-bold text-black shadow-lg transition-transform hover:scale-[1.02] disabled:cursor-not-allowed disabled:opacity-40"
            >
              게임 시작하기
            </button>
          </div>
        </div>
      )}

      {/* 2. PLAYING or GAME_OVER UI wrapper */}
      <div className={`mx-auto max-w-6xl px-6 py-8 ${gameState === 'INPUT' ? 'hidden' : 'block'}`}>

        {/* Header - hide on game over */}
        <div className={`mb-5 ${gameState === 'GAME_OVER' ? 'hidden' : 'block'}`}>
          <h1 className="text-2xl font-bold tracking-tight">Hand Color Catch Game</h1>
          <p className="mt-2 text-sm text-white/70">
            양손의 색상을 구분하여 같은 색의 공만 잡는 방식의 웹캠 모션 게임입니다.
          </p>
        </div>

        {/* Legend - hide on game over */}
        <div className={`mb-4 flex flex-wrap gap-3 pointer-events-none ${gameState === 'GAME_OVER' ? 'hidden' : 'flex'}`}>
          {legend.map((item) => (
            <div
              key={item.role}
              className="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm text-white/80 backdrop-blur"
            >
              <span
                className="h-3.5 w-3.5 rounded-full"
                style={{ backgroundColor: ROLE_COLORS[item.role] }}
              />
              {item.label}
            </div>
          ))}
          <div className="rounded-full border border-red-400/20 bg-red-400/10 px-4 py-2 text-sm text-red-100 backdrop-blur">
            게임 종료: MISS {MAX_MISSES}회 초과 시
          </div>
        </div>

        {/* Layout Grid container */}
        <div className={`grid gap-6 ${gameState === 'GAME_OVER' ? 'block' : 'lg:grid-cols-[minmax(0,1fr)_320px]'}`}>

          {/* Main Camera Canvas */}
          <div className={`relative overflow-hidden rounded-[28px] border border-cyan-400/25 bg-black shadow-[0_0_40px_rgba(46,214,255,0.12)] ${gameState === 'GAME_OVER' ? 'hidden' : 'block'}`}>
            <video ref={videoRef} className="hidden" playsInline muted />
            <canvas ref={canvasRef} className="block h-auto w-full object-cover" />

            {!ready && !error && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/80 backdrop-blur-md">
                <div className="flex flex-col items-center">
                  <div className="h-10 w-10 animate-spin rounded-full border-4 border-white/10 border-t-cyan-400 mb-4"></div>
                  <div className="rounded-2xl border border-white/10 bg-white/5 px-6 py-3 text-sm font-medium text-white/80 shadow-2xl">
                    웹캠을 켜고 손 인식 모델을 로드하는 중...
                  </div>
                </div>
              </div>
            )}

            {error && (
              <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/80 px-6 text-center backdrop-blur-md">
                <div className="max-w-md rounded-2xl border border-red-500/30 bg-red-500/10 px-6 py-5 text-sm font-medium text-red-200 shadow-2xl">
                  {error}
                </div>
              </div>
            )}
          </div>

          {gameState === 'GAME_OVER' && (
            <aside className="mx-auto mt-6 flex w-full max-w-2xl flex-col rounded-[32px] border border-cyan-400/20 bg-[#0c1220]/80 px-12 py-16 backdrop-blur-xl shadow-2xl transition-all duration-700">
              <div className="mb-12 text-center">
                <h2 className="mb-4 text-7xl font-black italic tracking-tighter text-[#ff4db8] drop-shadow-[0_0_40px_rgba(255,77,184,0.5)]">
                  GAME OVER
                </h2>
                <div className="inline-flex items-center gap-3 rounded-full border border-cyan-400/30 bg-cyan-900/30 px-6 py-3 shadow-[0_0_20px_rgba(46,214,255,0.15)]">
                  <span className="text-xl font-medium text-white/90">{playerNameRef.current} 님의 최종 점수:</span>
                  <span className="text-3xl font-extrabold text-cyan-300">{scoreRef.current}</span>
                </div>
              </div>

              <div className="mb-5 flex flex-col">
                <h2 className="text-center text-3xl font-extrabold tracking-tight text-white">
                  Score Ranking
                </h2>
                <p className="mt-1 text-center text-base text-white/50">
                  최상위 유저 기록 점수
                </p>
              </div>

              <div className="max-h-[320px] flex-1 space-y-3 overflow-y-auto pr-2 scrollbar-thin scrollbar-track-white/5 scrollbar-thumb-white/20">
                {ranking.length === 0 ? (
                  <div className="flex h-32 items-center justify-center rounded-2xl border border-white/5 bg-black/20 text-sm font-medium text-white/30">
                    아직 기록이 없습니다.
                  </div>
                ) : (
                  ranking.map((item, index) => {
                    const isLatestScore =
                      index === 0 &&
                      item.score === scoreRef.current &&
                      item.name === playerNameRef.current.trim();

                    return (
                      <div
                        key={`${item.name}-${item.score}-${item.date}-${index}`}
                        className={`flex items-center justify-between rounded-2xl border px-5 py-4 transition-all duration-300 ${isLatestScore
                          ? 'scale-[1.02] border-cyan-400/40 bg-cyan-900/30 shadow-[0_0_20px_rgba(46,214,255,0.2)]'
                          : 'border-white/5 bg-black/20 hover:border-white/10 hover:bg-black/30'
                          }`}
                      >
                        <div className="flex items-center gap-4">
                          <div
                            className={`flex h-10 w-10 items-center justify-center rounded-full text-lg font-black ${index === 0
                              ? 'bg-yellow-500/20 text-yellow-400 ring-1 ring-yellow-500/50'
                              : index === 1
                                ? 'bg-slate-300/20 text-slate-300 ring-1 ring-slate-400/30'
                                : index === 2
                                  ? 'bg-amber-700/20 text-amber-500 ring-1 ring-amber-700/50'
                                  : 'bg-white/5 font-bold text-white/40'
                              }`}
                          >
                            {index + 1}
                          </div>
                          <div>
                            <div className="text-xl font-bold text-white">{item.name}</div>
                            <div className="mt-0.5 text-sm text-white/40">{item.date}</div>
                          </div>
                        </div>
                        <div
                          className={`text-4xl font-black tracking-tight text-cyan-400 ${isLatestScore ? 'drop-shadow-[0_0_10px_rgba(46,214,255,0.4)]' : ''
                            }`}
                        >
                          {item.score}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

              <div className="mt-12 border-t border-white/10 pt-8">
                <button
                  onClick={restartGame}
                  className="w-full rounded-2xl bg-gradient-to-r from-[#ff4db8] to-[#ff2a85] px-4 py-5 text-xl font-bold text-white shadow-[0_0_30px_rgba(255,77,184,0.4)] transition-all hover:scale-[1.03] active:scale-[0.97]"
                >
                  새로운 게임 시작하기 (Restart)
                </button>
              </div>
            </aside>
          )}
        </div>
      </div>
    </main>
  );
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
) {
  const r = clamp(radius, 0, Math.min(width, height) / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}
