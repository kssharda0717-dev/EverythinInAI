const db = require('./engine/core/database').getClient();
const Replicate = require('replicate');

(async () => {
  const { data: heroStep } = await db.from('render_steps').select('output').eq('step_name', 'hero').order('created_at', { ascending: false }).limit(1).single();
  const { data: voiceStep } = await db.from('render_steps').select('output').eq('step_name', 'voice').order('created_at', { ascending: false }).limit(1).single();
  
  let heroUrl = heroStep?.output?.url;
  if (!heroUrl && heroStep?.output?.stdout) {
    const match = heroStep.output.stdout.match(/url\s+:\s+(https:\/\/[^\s]+)/);
    if (match) heroUrl = match[1];
  }
  
  let voiceUrl = voiceStep?.output?.audio;
  if (!voiceUrl && voiceStep?.output?.stdout) {
    const match = voiceStep.output.stdout.match(/audio\s+:\s+(https:\/\/[^\s]+)/);
    if (match) voiceUrl = match[1];
  }

  console.log('Hero URL:', heroUrl);
  console.log('Voice URL:', voiceUrl);

  if (!heroUrl || !voiceUrl) {
    console.log('Could not find both URLs. Aborting test to save money.');
    return;
  }

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
