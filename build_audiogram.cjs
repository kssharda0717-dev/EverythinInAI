const db = require('./engine/core/database').getClient();
const { execSync } = require('child_process');
const fs = require('fs');

(async () => {
  let heroUrl = 'https://riwmmixvqaavxmhwvixv.supabase.co/storage/v1/object/public/avi-images/keyframes/f6c7c97b-dbb5-4235-9ee6-2fd89711c260/hero-1778485817825.webp';
  let voiceUrl = 'https://riwmmixvqaavxmhwvixv.supabase.co/storage/v1/object/public/avi-images/voice-tracks/f6c7c97b-dbb5-4235-9ee6-2fd89711c260/1778485846586.wav';

  console.log('Hero URL:', heroUrl);
  console.log('Voice URL:', voiceUrl);

  execSync(`curl -sL -o /tmp/hero.webp "${heroUrl}"`);
  execSync(`curl -sL -o /tmp/voice.wav "${voiceUrl}"`);
  console.log('Assets downloaded.');

  const { data: cal } = await db.from('content_calendar').select('id, concept_id').eq('target_date', '2026-05-11').eq('content_type', 'tech_reel').maybeSingle();
  const { data: concept } = await db.from('reel_concepts').select('full_script').eq('id', cal.concept_id).maybeSingle();
  
  const words = concept.full_script.split(/\s+/);
  const durationSec = 30; 
  const timePerWord = durationSec / words.length;
  
  let assContent = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1350
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Montserrat,110,&H00FFFFFF,&H000000FF,&H00000000,&HC8000000,1,0,0,0,100,100,0,0,1,8,4,2,80,80,250,1
Style: Highlight,Montserrat,110,&H0000FFFF,&H000000FF,&H00000000,&HC8000000,1,0,0,0,100,100,0,0,1,8,4,2,80,80,250,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const assTime = (s) => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = (s % 60).toFixed(2);
    return `${h}:${m.toString().padStart(2, '0')}:${sec.padStart(5, '0')}`;
  };

  const HIGHLIGHT_WORDS = /^(WILD|UNHINGED|CRAZY|HUGE|MASSIVE|HONESTLY|LITERALLY|YAAR|MATLAB|OKAY)$/i;

  for (let i = 0; i < words.length; i++) {
    const start = i * timePerWord;
    const end = (i + 1) * timePerWord;
    const word = words[i];
    const isHighlight = HIGHLIGHT_WORDS.test(word.replace(/[^a-z]/gi, ''));
    const style = isHighlight ? 'Highlight' : 'Default';
    const text = `{\\fad(60,60)\\fscx140\\fscy140\\t(0,150,\\fscx100\\fscy100)}${word}`;
    assContent += `Dialogue: 0,${assTime(start)},${assTime(end)},${style},,0,0,0,,${text}\n`;
  }

  fs.writeFileSync('/tmp/subs.ass', assContent);
  console.log('Subtitles generated.');

  console.log('Running ffmpeg...');
  try {
    execSync(`ffmpeg -y -loop 1 -i /tmp/hero.webp -i /tmp/voice.wav -c:v libx264 -c:a aac -b:a 192k -shortest -vf "scale=1080:1350:force_original_aspect_ratio=increase,crop=1080:1350,ass=/tmp/subs.ass" /tmp/audiogram.mp4`);
    console.log('ffmpeg complete.');
  } catch (err) {
    console.log('ffmpeg failed:', err.message);
    return;
  }

  console.log('Uploading to Supabase...');
  const buf = fs.readFileSync('/tmp/audiogram.mp4');
  const destPath = `reels/${cal.concept_id}/audiogram-${Date.now()}.mp4`;
  const { error: upErr } = await db.storage.from('avi-images').upload(destPath, buf, { contentType: 'video/mp4', upsert: true });
  if (upErr) {
    console.log('Upload failed:', upErr.message);
    return;
  }
  
  const { data: pub } = db.storage.from('avi-images').getPublicUrl(destPath);
  console.log('\nSUCCESS! Audio-gram video URL:');
  console.log(pub.publicUrl);

})();
