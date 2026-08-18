// Curated background photos (Unsplash License — free for commercial/noncommercial use).
// Bundled locally via Vite's asset pipeline rather than hotlinked, so the editor still
// works offline and isn't subject to the CDN's availability.
import abstractNoir from "./textures/abstract-noir.jpg";
import barkBlue from "./textures/bark-blue.jpg";
import wallCrimson from "./textures/wall-crimson.jpg";
import barkCloseup from "./textures/bark-closeup.jpg";
import fabricBlack from "./textures/fabric-black.jpg";
import wavyCrimson from "./textures/wavy-crimson.jpg";
import wallMono from "./textures/wall-mono.jpg";
import abstractMono from "./textures/abstract-mono.jpg";
import blurTeal from "./textures/blur-teal.jpg";

import confetti from "./images/confetti.jpg";
import clouds from "./images/clouds.jpg";
import galaxyPeak from "./images/galaxy-peak.jpg";
import outerSpace from "./images/outer-space.jpg";
import whiteLeaves from "./images/white-leaves.jpg";
import neonParticles from "./images/neon-particles.jpg";
import foggyMountains from "./images/foggy-mountains.jpg";

// Keyed by BackgroundTexturePreset.id / BackgroundImagePreset.id (shared/types/models.ts).
export const BACKGROUND_TEXTURE_URLS: Record<string, string> = {
  "abstract-noir": abstractNoir,
  "bark-blue": barkBlue,
  "wall-crimson": wallCrimson,
  "bark-closeup": barkCloseup,
  "fabric-black": fabricBlack,
  "wavy-crimson": wavyCrimson,
  "wall-mono": wallMono,
  "abstract-mono": abstractMono,
  "blur-teal": blurTeal,
};

export const BACKGROUND_IMAGE_URLS: Record<string, string> = {
  confetti,
  clouds,
  "galaxy-peak": galaxyPeak,
  "outer-space": outerSpace,
  "white-leaves": whiteLeaves,
  "neon-particles": neonParticles,
  "foggy-mountains": foggyMountains,
};
