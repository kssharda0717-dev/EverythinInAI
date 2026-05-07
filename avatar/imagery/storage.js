/**
 * EverythinInAI — Imagery Storage Helper
 *
 * Downloads images from Replicate's CDN (the URLs expire after a few hours)
 * and rehosts them on Supabase Storage where they live forever and are
 * publicly readable for the video assembler.
 *
 * Bucket: 'avi-images' (must be created with public read in Supabase Storage UI
 * OR via the create_bucket RPC; we attempt to create it on first use).
 */

const axios = require('axios');
const dbModule = require('../../engine/core/database');
const { createLogger } = require('../../engine/utils/logger');

const log = createLogger('storage');

const BUCKET = 'avi-images';
let bucketEnsured = false;

async function ensureBucket() {
  if (bucketEnsured) return;
  const db = dbModule.getClient();
  // Try to list; if the bucket doesn't exist, create it.
  const { data: buckets } = await db.storage.listBuckets();
  const exists = (buckets || []).some(b => b.name === BUCKET);
  if (!exists) {
    log.info(`Creating storage bucket "${BUCKET}"...`);
    const { error } = await db.storage.createBucket(BUCKET, { public: true });
    if (error && !String(error.message || '').includes('already exists')) {
      log.warn(`Bucket create returned: ${error.message} — proceeding anyway`);
    }
  }
  bucketEnsured = true;
}

/**
 * Download a remote image URL → upload to Supabase Storage → return public URL.
 * @param {string} sourceUrl
 * @param {string} destPath e.g. 'face-anchors/avi/<uuid>.webp'
 * @returns {Promise<{publicUrl, storagePath, sizeBytes, contentType}>}
 */
async function rehostImage(sourceUrl, destPath) {
  await ensureBucket();
  const db = dbModule.getClient();

  // 1. Download
  const resp = await axios.get(sourceUrl, {
    responseType: 'arraybuffer',
    timeout: 60_000,
  });
  const buf = Buffer.from(resp.data);
  const contentType = resp.headers['content-type'] || 'image/webp';

  // 2. Upload to Supabase Storage
  const { error: upErr } = await db.storage
    .from(BUCKET)
    .upload(destPath, buf, {
      contentType,
      upsert: true,
      cacheControl: '31536000',  // 1 year
    });

  if (upErr) throw new Error(`Storage upload failed: ${upErr.message}`);

  // 3. Get public URL
  const { data: pub } = db.storage.from(BUCKET).getPublicUrl(destPath);
  const publicUrl = pub.publicUrl;

  log.info(`✓ rehosted ${buf.length} bytes → ${destPath}`);

  return {
    publicUrl,
    storagePath: destPath,
    sizeBytes: buf.length,
    contentType,
  };
}

module.exports = { rehostImage, BUCKET };
