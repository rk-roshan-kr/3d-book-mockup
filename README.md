# BookStudio 3D: Hyper-Realistic Book Mockup Generator

Welcome to **BookStudio 3D**, a professional-grade web-based photoshoot studio and 3D mockup generator for book cover designs. This tool is preloaded with your cover designs and configured for the exact dimensions specified in your templates.

## Features

- **Interactive 3D Engine**: Built on Three.js with full orbital controls, PBR materials, tone mapping, and soft dynamic shadows.
- **Auto-Cropping Engine**: Upload a single print spread cover file (Back cover + Spine + Front cover). The app dynamically crops it into three individual textures based on your exact book size and spine thickness.
- **Cover Style Toggles**: Switch between **Hardcover** (with custom boards, hinges, page indents, and board overhangs) and **Paperback** (flush edges, smooth spines).
- **Photoshoot Scene Presets**:
  - *Minimal Studio*: White neutral background with dual softboxes.
  - *Warm Editorial*: Warm lighting with organic leaf branch shadow projections.
  - *Midnight Mood*: Moody violet background, high-reflection metallic floor, and neon rim glows (blue & magenta).
  - *Rustic Workspace*: Procedural warm wooden plank table surface.
- **Tacit Material Customization**:
  - Matte, glossy (using physical clearcoats), and textured linen bump mapping.
  - White, cream, and groundwood paper profiles.
  - Gilded page edges (Gold foil, Silver foil, Matte black, or Custom colors).
- **Studio Export**:
  - High-resolution rendering at 2K/4K scaling.
  - PNG export with opaque studio backing or transparent alpha channel (great for compositing!).

## Files Copied & Available

1. [agi-question.png](file:///d:/TEMP-3d_mockup/agi-question.png): High-resolution cover spread for "THE AGI QUESTION" (Pre-configured default cover!).
2. [cover_whatsapp.jpg](file:///d:/TEMP-3d_mockup/cover_whatsapp.jpg): Secondary cover style.
3. [case_laminate_template.pdf](file:///d:/TEMP-3d_mockup/case_laminate_template.pdf): KDP Case Laminate template guide.

## How to Run locally

Since WebGL textures require local file hosting (otherwise Chrome triggers a CORS policy error), you must run this using a local development server:

1. Open a PowerShell/Terminal window in `d:\TEMP-3d mockup`.
2. Start the Vite dev server by running:
   ```powershell
   npm run dev
   ```
3. A browser window will automatically launch at `http://localhost:3000`.
4. Click the **"Load Demo Cover"** button in the top right to instantly load and split the "THE AGI QUESTION" cover!
