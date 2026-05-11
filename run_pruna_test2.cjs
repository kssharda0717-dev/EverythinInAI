const db = require('./engine/core/database').getClient();
const Replicate = require('replicate');
(async () => {
  // Use known good URLs from the earlier output
  const heroUrl = 'https://riwmmixvqaavxmhwvixv.supabase.co/storage/v1/object/public/avi-images/keyframes/f6c7c97b-dbb5-4235-9ee6-2fd89711c260/hero-1778485817825.webp';
  const voiceUrl = 'https://riwmmixvqaavxmhwvixv.supabase.co/storage/v1/object/public/avi-images/voice-tracks/f6c7c97b-dbb5-4235-9ee6-2fd89711c260/1778485846586.wav';

  console.log('Hero URL:', heroUrl);
  console.log('Voice URL:', voiceUrl);

  console.log('Running Pruna p-video-avatar 720p...');
  const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
  try {
    const output = await replicate.run(
      "prunaai/p-video-avatar:latest",
      {
        input: {
          image: heroUrl,
          audio: voiceUrl,
          resolution: "720p"
        }
      }
    );
    console.log('\nSUCCESS! Pruna video URL:');
    console.log(output);
  } catch (err) {
    console.log('Pruna test failed:', err.message);
  }
})();
