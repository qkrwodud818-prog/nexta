/**
 * 카드뉴스 이미지(1080×1350) → 유튜브 숏츠용 세로 영상(1080×1920) MP4.
 *
 * 레이아웃은 sharp가, 인코딩만 ffmpeg가 맡는다. ffmpeg 필터로 배경 블러·정렬까지
 * 처리하면 명령이 길어지고 실패 지점이 늘어나는데, 프레임을 미리 완성해 두면
 * ffmpeg는 "정지 이미지들을 이어붙여라"만 하면 되므로 훨씬 안정적이다.
 */
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const sharp = require("sharp");
const ffmpegPath = require("ffmpeg-static");

const OUT_W = 1080, OUT_H = 1920; // 9:16
const SECONDS_PER_IMAGE = 4;
const FPS = 30;

/** 이미지 1장을 9:16 프레임으로 — 뒤에는 같은 이미지를 꽉 채워 흐리게 깔고, 앞에 원본을 얹는다. */
async function buildFrame(imagePath, outPath) {
  const background = await sharp(imagePath)
    .resize(OUT_W, OUT_H, { fit: "cover" })
    .blur(40)
    .modulate({ brightness: 0.55 })
    .toBuffer();

  const foreground = await sharp(imagePath)
    .resize(OUT_W, null, { fit: "inside" })
    .toBuffer();
  const fgMeta = await sharp(foreground).metadata();

  await sharp(background)
    .composite([{ input: foreground, top: Math.round((OUT_H - (fgMeta.height || 0)) / 2), left: 0 }])
    .png()
    .toFile(outPath);
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, args, { maxBuffer: 1024 * 1024 * 20 }, (err, stdout, stderr) => {
      if (err) return reject(new Error("영상 생성 실패: " + String(stderr || err.message).slice(-400)));
      resolve();
    });
  });
}

/**
 * 이미지들을 이어붙여 숏츠 MP4를 만든다.
 * @param {string[]} imagePaths 로컬 이미지 경로 (순서대로)
 * @param {string} outPath 출력 mp4 경로
 * @returns {Promise<{path:string, seconds:number}>}
 */
/* durations: 장면별 길이(초). 안 주면 전부 SECONDS_PER_IMAGE.
   훅 장면은 짧고 굵게, 설명 장면은 읽을 시간을 줘야 해서 길이가 달라야 한다. */
async function generateShort(imagePaths, outPath, durations) {
  const images = imagePaths.filter((p) => p && fs.existsSync(p));
  if (!images.length) throw new Error("영상으로 만들 이미지가 없습니다.");

  const workDir = path.join(path.dirname(outPath), "_frames");
  fs.mkdirSync(workDir, { recursive: true });

  try {
    const frames = [];
    for (let i = 0; i < images.length; i++) {
      const framePath = path.join(workDir, `f${i}.png`);
      await buildFrame(images[i], framePath);
      frames.push(framePath);
    }

    // concat 디머서는 마지막 항목의 duration을 무시하므로 마지막 프레임을 한 번 더 적어준다.
    const listPath = path.join(workDir, "list.txt");
    const secFor = (i) => (Array.isArray(durations) && durations[i] > 0 ? durations[i] : SECONDS_PER_IMAGE);
    const lines = frames.map((f, i) => `file '${f.replace(/\\/g, "/")}'\nduration ${secFor(i)}`);
    lines.push(`file '${frames[frames.length - 1].replace(/\\/g, "/")}'`);
    fs.writeFileSync(listPath, lines.join("\n"), "utf8");

    const seconds = frames.reduce((n, _, i) => n + secFor(i), 0);
    await runFfmpeg([
      "-y",
      "-f", "concat", "-safe", "0", "-i", listPath,
      // 무음 트랙을 함께 넣는다 — 오디오가 아예 없으면 일부 플랫폼이 처리에 실패한다.
      "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
      "-shortest",
      "-vf", `fps=${FPS},format=yuv420p`,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
      "-c:a", "aac", "-b:a", "64k",
      "-movflags", "+faststart",
      "-t", String(seconds),
      outPath,
    ]);

    return { path: outPath, seconds };
  } finally {
    // 프레임은 중간 산출물이라 영상이 나오면 지운다 (무료 호스팅 디스크가 넉넉하지 않다).
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

module.exports = { generateShort, OUT_W, OUT_H, SECONDS_PER_IMAGE };
