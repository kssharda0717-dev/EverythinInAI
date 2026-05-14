/**
 * EverythinInAI — Canonical Rhea Look Anchor (SHARED ACROSS ALL 3 STREAMS)
 *
 * This file is the single source of truth for what Rhea looks like.
 * It is imported by:
 *   - avatar/imagery/hero_worker.js          (Mon-Thu tech reels)
 *   - avatar/lure/lure_photo_worker.js       (Friday lure photos)
 *   - avatar/lifestyle/lifestyle_worker.js   (Sat-Sun lifestyle videos + dance mode)
 *
 * The reference image lives at:
 *   avatar/persona/references/canonical_rhea.webp
 *
 * Empirical color analysis of that reference image (sampled across forehead,
 * cheeks, chin):
 *   AVG SKIN HEX = #A17B63   RGB = (161, 124,  99)   warm wheatish
 *
 * Empirical color of the rendered tech-reel that the user rejected:
 *   AVG SKIN HEX = #7F4A30   RGB = (128,  74,  48)   deep bronze
 *   Drift = -34% luminance (~8 shades darker on Fitzpatrick scale)
 *
 * Why a single source of truth matters:
 *   Without this, each worker had its own incomplete description and Rhea
 *   drifted differently on different days (bronzed on tech, paler on lure,
 *   curvy-but-darker on lifestyle). Now every render pulls from this exact
 *   string, so identity stays locked.
 *
 * IMPORTANT: This module describes the FACE / SKIN / HAIR / MAKEUP / JEWELRY
 * only. It deliberately does NOT include framing or body type because:
 *   - Tech reels = head-and-shoulders only (no body shown)
 *   - Lure photos = full body, curvy hourglass tasteful
 *   - Lifestyle = full body, athletic / dynamic
 * Each worker adds its own framing + body anchor on top.
 */

// ============================================================================
// CANONICAL_LOOK
// Every distinctive feature of the reference image, named explicitly so Flux
// has nothing to hallucinate. Order matters: skin first because that's the
// most-drifted attribute.
// ============================================================================
const CANONICAL_LOOK = [
  // 1. Skin — hex-anchored, double-negated, north-Indian-specific
  'fair north-Indian wheatish complexion (skin tone hex roughly #A17B63, soft warm beige with subtle pink undertone, light enough that her cheekbones catch warm highlights cleanly), the complexion of a young Delhi-born North-Indian woman who works indoors in air-conditioned offices, NEVER tanned, NEVER dusky, NEVER bronze, NEVER sun-kissed dark, NEVER deep brown',
  // 2. Hair — long, loose, wavy (NOT tight bun, NOT pulled back tight)
  'long dark brown softly wavy hair flowing loosely down past her shoulders on both sides of her face with natural face-framing pieces, side part, soft volume at the crown, natural beach-wave texture',
  // 3. Eyes / brows — defined but soft
  'large warm dark brown almond-shaped eyes with soft lifted eyeliner and lightly defined natural brows, calm intelligent gaze',
  // 4. Makeup — soft glam, mauve-pink lip
  'soft natural glam makeup with a dewy finish (NOT matte, NOT plastic): subtle peach blush on cheekbones, soft mauve-pink lips with a gentle gloss, lightly contoured nose, no heavy eyeshadow, no bold lipstick',
  // 5. Jewelry — small gold hoops only as default; specific scenes can override
  'small or medium plain gold hoop earrings (default jewelry, can be omitted for specific scenes), no necklace unless the scene explicitly calls for one',
  // 6. Face shape — anchors LoRA identity
  'oval face with soft jawline, high cheekbones, naturally full but not exaggerated lips, slim straight nose with a small gentle tip',
].join(', ');

// ============================================================================
// COMPLEXION_NEGATIONS
// Reusable string of "NOT this" instructions. Append to any prompt that needs
// extra-strong skin-tone protection (e.g., golden-hour or sunset scenes).
// ============================================================================
const COMPLEXION_NEGATIONS =
  'Skin tone must be fair-to-medium wheatish (hex around #A17B63), NOT tanned, NOT dusky, NOT bronzed, NOT sun-kissed dark, NOT deep brown, NOT South-Indian deep complexion. She is fair, the way a young Delhi-born indoor-working woman is fair.';

// ============================================================================
// DIGNITY_ANCHOR (default — used by tech reels)
// IIT Mumbai grad / Goldman Sachs analyst energy. Smart hot, intellectual hot,
// elegant hot — never trashy, never vulgar, never sexualized.
// ============================================================================
const DIGNITY_ANCHOR =
  'smart intellectual elegance, IIT-Mumbai-graduate energy, Goldman Sachs analyst poise, dignified professional presence, beautiful and magnetic but tasteful, NEVER vulgar, NEVER trashy, NEVER cheap, NEVER thirst-trap';

// ============================================================================
// LURE_DIGNITY_ANCHOR (Friday lure photos — more permissive than tech)
//
// Friday is the one day where allure is the entire brief. We want the photo
// to be magnetic, desirable, scroll-stopping — but still elegant, not crude.
// Reference register: Kiara Advani in a magazine cover, Tara Sutaria in a
// resort editorial, Sonam Kapoor at Cannes. Sensual but never explicit.
// What's allowed:
//   - hint of decolletage, soft V, off-shoulder, backless, fitted silhouette
//   - one-piece swimsuit at a pool, modest beachwear in beach scenes
//   - traditional saree blouse with hint of midriff (festive, cultural context)
//   - bedroom-loungewear in a luxury hotel room (silk slip, robe)
// What is BANNED:
//   - bralette/lingerie alone (always layered)
//   - explicit nudity or near-nudity
//   - any "come hither" / pornographic / overtly sexual pose
//   - vulgar or crude framing
//   - generic AI thirst-trap aesthetics (over-glossed plastic skin, bedroom
//     close-up with no context, soft-porn pose)
// ============================================================================
const LURE_DIGNITY_ANCHOR =
  'magnetic alluring desirable beautifully feminine energy (Kiara Advani / Tara Sutaria / Sonam Kapoor magazine-cover register), sensual but never explicit, hint of skin allowed within the scene context (decolletage, shoulder, midriff in saree, swimsuit at a pool, silk slip in a luxury hotel suite), the body is part of the lifestyle moment not the entire subject, IIT-Mumbai-grad-meets-magazine-cover quality, NEVER bralette or lingerie alone, NEVER explicit, NEVER "come hither" pornographic pose, NEVER crude, NEVER vulgar, NEVER generic AI thirst-trap, NEVER over-glossed plastic skin';

// ============================================================================
// LIFESTYLE_DIGNITY_ANCHOR (Sat-Sun lifestyle videos — athletic / dynamic)
//
// Lifestyle is about action and aspiration: gym, pilates, hiking, dancing,
// luxury drives, infinity pools. Body-confident but the focus is on the
// activity, not the body.
// ============================================================================
const LIFESTYLE_DIGNITY_ANCHOR =
  'athletic confident magnetic energy, body-positive but the focus is on the ACTIVITY (gym, pilates, hiking, dancing, swimming, driving) not on the body, the body is incidental to the action, joyful and aspirational, NEVER posing for the camera, NEVER thirst-trap, NEVER crude';

// ============================================================================
// LIGHTING_NEUTRAL_DAYLIGHT
// Default lighting recipe that does NOT cause skin darkening.
// Use this on tech reels and any indoor lure/lifestyle scene that doesn't
// explicitly require golden hour. Warm directional light is the #2 cause
// of bronze skin drift after Flux's Indian-creator prior.
// ============================================================================
const LIGHTING_NEUTRAL_DAYLIGHT =
  'soft even cool-neutral natural daylight from a large window off-camera, gentle wrap-around shadows on her face, NOT golden-hour warm orange light, NOT tungsten warm light, NOT sunset light, NOT directional warm spotlight, NOT studio glow';

// ============================================================================
// LIGHTING_GOLDEN_SAFE
// For scenes that NEED golden hour (rooftop, beach, balcony at sunset).
// Same warmth allowance but with explicit skin-tone protection.
// ============================================================================
const LIGHTING_GOLDEN_SAFE =
  'soft golden-hour ambient light WITHOUT bronzing the skin (warm rim light only, key light remains soft and neutral on the face so her wheatish complexion stays visible)';

module.exports = {
  CANONICAL_LOOK,
  COMPLEXION_NEGATIONS,
  DIGNITY_ANCHOR,
  LURE_DIGNITY_ANCHOR,
  LIFESTYLE_DIGNITY_ANCHOR,
  LIGHTING_NEUTRAL_DAYLIGHT,
  LIGHTING_GOLDEN_SAFE,
};
