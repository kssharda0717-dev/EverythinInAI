const db = require('./engine/core/database').getClient();
const Replicate = require('replicate');
(async () => {
  const heroUrl = 'https://riwmmixvqaavxmhwvixv.supabase.co/storage/v1/object/public/avi-images/keyframes/f6c7c97b-dbb5-4235-9ee6-2fd89711c260/hero-1778485817825.webp';
  const voiceUrl = 'https://riwmmixvqaavxmhwvixv.supabase.co/storage/v1/object/public/avi-images/voice-tracks/f6c7c97b-dbb5-4235-9ee6-2fd89711c260/1778485846586.wav';

  console.log('Running VEED Fabric 1.0 (480p)...');
  const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
  try {
    const output = await replicate.run(
      "veed/fabric-1.0",
      {
        input: {
          image: heroUrl,
          audio: voiceUrl,
          resolution: "480p"
        }
      }
    );
    console.log('\nSUCCESS! VEED video URL:');
    console.log(output);
  } catch (err) {
    console.log('VEED test failed:', err.message);
  }
})();
