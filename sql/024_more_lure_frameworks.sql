-- Migration 024: Add 6 more lure frameworks
--
-- Why: We had 6 lure frameworks. With the new framework-rotation logic
-- (avoid last 5 winners) and 3 concepts drafted per Friday, the registry
-- runs dry within 2 weeks. Adding 6 more for richer rotation, with a tilt
-- toward Indian-festive looks (which the user's audience responds to) and
-- toward "magnetic + intellectual" registers.
--
-- All entries follow the same prompt-template contract: each describes a
-- specific scene + activity + outfit + lighting + vibe. Gemini will use
-- these as instructions when drafting the actual image_prompt that gets
-- sent to Flux.

INSERT INTO content_frameworks (slug, stream, display_name, description, prompt_template, example_hook, generation, reasoning) VALUES

  ('diwali_saree_glow', 'lure', 'Diwali Saree Glow',
   'Festive Indian elegance — saree, diyas, warm string lights',
   'Generate a Lure photo concept where Rhea is in a beautifully decorated home for Diwali, sitting or standing near a row of lit diyas, holding a single diya in her hands or adjusting a string of marigold flowers behind her. Saree is rich silk in jewel tones (deep red, emerald, royal blue, burgundy). Hair is half-up with a small jasmine flower or maang tikka. Soft glowing diya lights illuminate her face with warm magnetic light. Vibe: cultural, magnetic, deeply rooted in Indian aesthetic, the post EVERY aunty texts the family group about.',
   'Diwali at home tonight', 1, 'Festive Indian content drives 3-5x engagement on Indian Instagram; saree is the highest-allure tasteful look possible'),

  ('balcony_kurta_sunset', 'lure', 'Balcony Kurta Sunset',
   'Soft Indian kurta on a Bandra balcony at golden hour',
   'Generate a Lure photo concept where Rhea is leaning on her Bandra apartment balcony railing at golden hour, looking out at the soft-focus Mumbai skyline, then turning her head toward the camera with a soft warm smile. Kurta is elegant and modern: block-printed cotton, anarkali style, or chic short kurta with chudidar. Hair loose with face-framing pieces or in a soft low bun. Vibe: cultural, intellectual, the smart Indian girl who reads books and lives well.',
   'Golden hour on the balcony', 1, 'Indian-traditional + Bandra-rooftop is the unique cultural intersection that no other AI influencer has'),

  ('udaipur_palace_lehenga', 'lure', 'Udaipur Palace Lehenga',
   'Heritage Indian palace courtyard + ornate lehenga',
   'Generate a Lure photo concept where Rhea is standing in a heritage palace courtyard in Udaipur (intricate stone carvings, arched doorways, lake view in soft focus). Wearing a vibrant lehenga (magenta, peacock blue, or saffron) with intricate zari embroidery and a modern blouse cut. Half-up hair with floral hair clip. Soft golden afternoon light. Vibe: royal Indian, deeply cultural, magazine-cover quality.',
   'Udaipur dreams', 1, 'Indian heritage architecture + ornate lehenga is the definitive scroll-stop on Indian Instagram'),

  ('library_silk_blouse', 'lure', 'Library Silk Blouse',
   'Intellectual magnetism in a wood-paneled library',
   'Generate a Lure photo concept where Rhea is sitting at a long wooden table in a beautiful private library or hotel library lounge (rich dark wood, leather chairs, brass reading lamps, walls lined with old hardcover books). She is reading an open hardcover book, half-glance toward the camera with a soft warm closed smile. Wearing a soft silk blouse (cream, blush, or champagne) with a tasteful soft V-neckline that shows hint of decolletage. Hair loose and wavy. Soft warm tungsten light from reading lamps. Vibe: extremely intellectual + magnetic, the IIT girl who reads philosophy and looks like a Vogue cover.',
   'Found a quiet corner', 1, 'Intellectual + magnetic is Rhea\u2019s entire brand differentiation \u2014 this scene IS her'),

  ('hotel_robe_morning', 'lure', 'Hotel Robe Morning',
   'Luxury hotel suite morning, plush white robe',
   'Generate a Lure photo concept where Rhea is standing or sitting at the floor-to-ceiling window of a luxury hotel suite in the morning, holding a small espresso cup, looking out then turning toward the camera with a soft warm smile. Wearing a plush white luxury hotel robe slipped slightly off one shoulder showing collarbone (NOT the chest, NOT the midriff). Hair in a messy high bun with face-framing pieces. Soft cool morning daylight from window + warm interior lamp. Vibe: luxurious morning ritual, aspirational wealth, soft magnetism.',
   'Slow mornings hit different', 1, 'Robe + hotel suite is a magnetic register; one shoulder showing is the boundary between alluring and crude'),

  ('art_gallery_blazer_lure', 'lure', 'Art Gallery Blazer',
   'Contemporary art gallery exploration in a tailored suit',
   'Generate a Lure photo concept where Rhea is exploring a contemporary art gallery, standing in front of a large abstract canvas, looking at the viewer with a knowing intelligent smile. Wearing a sleek tailored oversized beige or cream suit (blazer + matching wide-leg trousers) over a soft camisole or silk shell with a tasteful soft V (no cleavage). Hair loose and wavy. Soft museum spotlights creating directional light on her face. Vibe: intellectual + cultured + wealthy, the kind of woman who collects art.',
   'A quiet afternoon at the gallery', 1, 'Power-suit-in-art-gallery is the modern smart-hot register that signals depth + wealth')

ON CONFLICT (slug) DO NOTHING;

-- ─── SECURITY FUTURE-PROOFING (EXPLICIT GRANTS) ──────────────────────────────
-- Required for Supabase Data API changes (May/Oct 2026)
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE content_frameworks TO authenticated, service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated, service_role;

-- Reload the PostgREST schema cache
NOTIFY pgrst, 'reload schema';
