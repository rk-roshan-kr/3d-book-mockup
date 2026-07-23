import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// --- APPLICATION STATE ---
const state = {
  // Dimensions
  bookType: 'hardcover', // 'hardcover' or 'paperback'
  width: 6.0,           // in inches
  height: 9.0,          // in inches
  spineWidth: 0.558,    // in inches
  pages: 164,
  overhang: 0.12,       // hardcover cover overhang in inches
  boardThickness: 0.08, // hardcover board thickness in inches
  hingeGap: 0.15,       // gap between spine board and cover board in inches
  
  // Materials & Finishes
  coverFinish: 'matte', // 'matte', 'glossy', 'textured'
  paperColor: 'white',  // 'white', 'cream', 'groundwood'
  pageEdgeStyle: 'standard', // 'standard', 'gold', 'silver', 'black', 'custom'
  customEdgeColor: '#ffffff',
  
  // Composition
  composition: 'standing', // 'standing', 'lying', 'stacked'
  
  // Studio & Scene
  preset: 'studio',     // 'studio', 'warm-editorial', 'midnight-mood', 'wooden-desk'
  lightIntensity: 1.2,
  lightRotation: 45,    // degrees
  shadowSoftness: 0.5,
  dof: 0,
  fov: 45,
  showGrid: false,
  
  // Export Settings
  exportBg: 'opaque',    // 'opaque', 'transparent'
  exportScale: 2,       // 1, 2, 3
  
  // Texture Assets
  coverImage: null,     // HTML Image element
  coverImageSrc: null,  // original source URL / Base64
  
  // Cropped canvas textures
  frontTexture: null,
  spineTexture: null,
  backTexture: null,
  frontHingeTexture: null,
  backHingeTexture: null
};

// --- LOCALSTORAGE PERSISTENCE ---
const LS_KEY = 'bs3d_v3';
let _saveTimer = null;

function saveSettings() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    try {
      const data = {
        state: {
          bookType: state.bookType, width: state.width, height: state.height,
          spineWidth: state.spineWidth, pages: state.pages,
          coverFinish: state.coverFinish, paperColor: state.paperColor,
          pageEdgeStyle: state.pageEdgeStyle, customEdgeColor: state.customEdgeColor,
          preset: state.preset, lightIntensity: state.lightIntensity,
          lightRotation: state.lightRotation, shadowSoftness: state.shadowSoftness,
          dof: state.dof, fov: state.fov, showGrid: state.showGrid,
          exportBg: state.exportBg, exportScale: state.exportScale
        },
        objects: {}
      };
      // Save book group transform
      if (bookGroup) {
        data.objects.book = {
          px: bookGroup.position.x, py: bookGroup.position.y, pz: bookGroup.position.z,
          rx: bookGroup.rotation.x, ry: bookGroup.rotation.y, rz: bookGroup.rotation.z,
          s: bookGroup.scale.x, visible: bookGroup.visible
        };
      }
      // Save prop transforms
      loadedProps.forEach(p => {
        data.objects[p.name.toLowerCase()] = {
          px: p.group.position.x, py: p.group.position.y, pz: p.group.position.z,
          rx: p.group.rotation.x, ry: p.group.rotation.y, rz: p.group.rotation.z,
          s: p.group.scale.x, visible: p.group.visible
        };
      });
      localStorage.setItem(LS_KEY, JSON.stringify(data));
    } catch(e) { console.warn('BookStudio3D: save failed', e); }
  }, 600); // debounce 600ms
}

function loadSavedData() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch(e) { return null; }
}

function applySavedTransforms(saved) {
  if (!saved || !saved.objects) return;
  const o = saved.objects;
  if (bookGroup && o.book) {
    bookGroup.position.set(o.book.px, o.book.py, o.book.pz);
    bookGroup.rotation.set(o.book.rx, o.book.ry, o.book.rz);
    bookGroup.scale.setScalar(o.book.s ?? 1);
    bookGroup.visible = o.book.visible !== false;
  }
  loadedProps.forEach(p => {
    const key = p.name.toLowerCase();
    if (o[key]) {
      p.group.position.set(o[key].px, o[key].py, o[key].pz);
      p.group.rotation.set(o[key].rx, o[key].ry, o[key].rz);
      p.group.scale.setScalar(o[key].s ?? 1);
      p.group.visible = o[key].visible !== false;
    }
  });
}

// --- SYSTEM CONSTANTS & PROCEDURAL TEXTURE CACHE ---
const INCH_TO_THREE = 1.0; // scale factor: 1 inch = 1 Three.js unit
let renderer, scene, camera, controls;
let bookGroup;
let lights = {};
let gridHelper, polarHelper;
let leafShadowPlane; // floating plane for casting branch shadows
let floorPlane;
let wallShadowPlane; // vertical wall shadow catcher plane
let propsGroup;      // 3D scene props group (mug, plant, pen)
let loadedProps = []; // list of { group, name } for click-drag interaction

// Procedural textures
let linenBumpTexture, paperBumpTexture, pageEdgeTextureMap = {};

// Default colors
const paperColors = {
  white: '#fafafa',
  cream: '#f9f5eb',
  groundwood: '#e4dccb'
};

const pageEdgeColors = {
  standard: '#dedede',
  gold: '#d4af37',
  silver: '#c0c0c0',
  black: '#1a1a1a'
};

// --- PROCEDURAL TEXTURE GENERATORS ---

// Generate high-fidelity cross-hatch linen bump map (for hardcover cloth)
function generateLinenBumpTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 1024;
  const ctx = canvas.getContext('2d');
  
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, 1024, 1024);
  
  // Vertical warp threads
  for (let i = 0; i < 1024; i += 3) {
    ctx.globalAlpha = 0.12 + Math.random() * 0.1;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(i, 0, 1.2, 1024);
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(i + 1.5, 0, 0.8, 1024);
  }
  ctx.globalAlpha = 1.0;
  // Horizontal weft threads (perpendicular)
  for (let i = 0; i < 1024; i += 3) {
    ctx.globalAlpha = 0.10 + Math.random() * 0.08;
    ctx.fillStyle = '#c0c0c0';
    ctx.fillRect(0, i, 1024, 1.0);
    ctx.fillStyle = '#2a2a2a';
    ctx.fillRect(0, i + 1.5, 1024, 0.7);
  }
  ctx.globalAlpha = 1.0;
  
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(3, 3);
  return tex;
}

// Generate micro-fiber matte coating texture for paperback covers
function generateMatteCoatTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, 512, 512);
  const imgData = ctx.getImageData(0, 0, 512, 512);
  const d = imgData.data;
  // Multi-scale noise for micro-fiber feel
  for (let y = 0; y < 512; y++) {
    for (let x = 0; x < 512; x++) {
      const idx = (y * 512 + x) * 4;
      // Fine grain
      const n1 = (Math.random() - 0.5) * 18;
      // Medium blotch
      const n2 = Math.sin(x * 0.08) * Math.cos(y * 0.06) * 6;
      const val = Math.max(0, Math.min(255, 128 + n1 + n2));
      d[idx] = d[idx+1] = d[idx+2] = val;
      d[idx+3] = 255;
    }
  }
  ctx.putImageData(imgData, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(2, 2);
  return tex;
}

// Generate simple paper noise bump map
function generatePaperBumpTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');
  
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, 512, 512);
  
  const imgData = ctx.getImageData(0, 0, 512, 512);
  const data = imgData.data;
  
  for (let i = 0; i < data.length; i += 4) {
    const val = 128 + (Math.random() - 0.5) * 22;
    data[i] = data[i+1] = data[i+2] = val;
    data[i+3] = 255;
  }
  
  ctx.putImageData(imgData, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(4, 4);
  return tex;
}

// Generate lines texture to simulate page stack edges
function generatePageEdgeTexture(colorHex, isVertical = false) {
  const cacheKey = `${colorHex}_${isVertical}`;
  if (pageEdgeTextureMap[cacheKey]) return pageEdgeTextureMap[cacheKey];

  const canvas = document.createElement('canvas');
  canvas.width = isVertical ? 32 : 512;
  canvas.height = isVertical ? 512 : 32;
  const ctx = canvas.getContext('2d');
  
  // Base paper color
  ctx.fillStyle = colorHex;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  
  // Draw parallel lines to simulate pages
  ctx.strokeStyle = '#000000';
  const size = isVertical ? canvas.height : canvas.width;
  
  for (let i = 0; i < size; i += 2 + Math.floor(Math.random() * 2)) {
    ctx.globalAlpha = 0.05 + Math.random() * 0.12;
    ctx.lineWidth = 0.5 + Math.random() * 1.0;
    ctx.beginPath();
    if (isVertical) {
      ctx.moveTo(0, i);
      ctx.lineTo(canvas.width, i);
    } else {
      ctx.moveTo(i, 0);
      ctx.lineTo(i, canvas.height);
    }
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  
  if (isVertical) {
    tex.repeat.set(1, 10);
  } else {
    tex.repeat.set(10, 1);
  }
  
  pageEdgeTextureMap[cacheKey] = tex;
  return tex;
}

// Draw a leaf outline to use as branch shadow stencil
function generateLeafStencilCanvas() {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');
  
  // Transparent background
  ctx.clearRect(0, 0, 512, 512);
  ctx.fillStyle = '#000000'; // shadow blocking area
  
  // Draw a branch with organic leaf shapes
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 8;
  
  // Main stem
  ctx.beginPath();
  ctx.moveTo(50, 450);
  ctx.bezierCurveTo(150, 400, 350, 200, 450, 50);
  ctx.stroke();
  
  // Helper to draw a leaf
  function drawLeaf(cx, cy, angle, length, width) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);
    
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.bezierCurveTo(length / 3, -width / 2, (length * 2) / 3, -width / 2, length, 0);
    ctx.bezierCurveTo((length * 2) / 3, width / 2, length / 3, width / 2, 0, 0);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  
  // Add leaves along the stem
  drawLeaf(150, 370, -Math.PI / 4, 80, 30);
  drawLeaf(200, 330, Math.PI / 6, 75, 28);
  drawLeaf(250, 280, -Math.PI / 5, 85, 32);
  drawLeaf(300, 230, Math.PI / 7, 70, 26);
  drawLeaf(350, 170, -Math.PI / 4.5, 90, 35);
  drawLeaf(400, 110, Math.PI / 8, 65, 24);
  drawLeaf(430, 70, -Math.PI / 6, 50, 18);
  
  return canvas;
}

// Procedural wood desk texture
function generateWoodTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 1024;
  const ctx = canvas.getContext('2d');
  
  // Base wood color
  ctx.fillStyle = '#5c3a21';
  ctx.fillRect(0, 0, 1024, 1024);
  
  // Draw wood planks
  const plankWidth = 204.8; // 5 planks
  ctx.fillStyle = 'rgba(0, 0, 0, 0.15)';
  for (let i = 0; i < 5; i++) {
    ctx.fillRect(i * plankWidth, 0, 2, 1024);
  }
  
  // Wood grain layers
  for (let plank = 0; plank < 5; plank++) {
    const startX = plank * plankWidth;
    ctx.save();
    
    // Set clipping path for the plank
    ctx.beginPath();
    ctx.rect(startX, 0, plankWidth, 1024);
    ctx.clip();
    
    // Draw wavy lines
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.12)';
    ctx.lineWidth = 1.5;
    
    const waveCount = 25 + Math.random() * 15;
    for (let w = 0; w < waveCount; w++) {
      const xOffset = startX + (w / waveCount) * plankWidth + (Math.random() - 0.5) * 15;
      
      ctx.beginPath();
      ctx.moveTo(xOffset, 0);
      // Create organic wave curves
      let currentX = xOffset;
      let currentY = 0;
      while (currentY < 1024) {
        const nextY = currentY + 40 + Math.random() * 40;
        const offset = Math.sin(currentY * 0.015 + plank) * 8 + (Math.random() - 0.5) * 2;
        ctx.lineTo(xOffset + offset, nextY);
        currentY = nextY;
      }
      ctx.stroke();
    }
    
    // Draw wood knots
    if (Math.random() > 0.4) {
      const knotY = 200 + Math.random() * 600;
      const knotX = startX + plankWidth / 2 + (Math.random() - 0.5) * 40;
      
      ctx.fillStyle = 'rgba(0, 0, 0, 0.2)';
      ctx.beginPath();
      ctx.arc(knotX, knotY, 15 + Math.random() * 15, 0, Math.PI * 2);
      ctx.fill();
      
      // Ring swirls around knot
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.15)';
      for (let r = 1; r < 5; r++) {
        ctx.beginPath();
        ctx.arc(knotX, knotY, r * 20 + Math.random() * 5, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    
    ctx.restore();
  }
  
  // Warm overlay gradient
  const grad = ctx.createLinearGradient(0, 0, 1024, 1024);
  grad.addColorStop(0, 'rgba(255, 200, 150, 0.05)');
  grad.addColorStop(1, 'rgba(0, 0, 0, 0.35)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 1024, 1024);

  const tex = new THREE.CanvasTexture(canvas);
  return tex;
}

// --- COVER SPLITTING SYSTEM ---

// Crop cover image and update the Three.js textures
function cropCoverWrap() {
  if (!state.coverImage) return;

  const img = state.coverImage;
  const imgW = img.naturalWidth;
  const imgH = img.naturalHeight;

  // Let's determine overall layout dimension boundaries.
  // Standard hardcover print templates include wrap/bleed margins.
  // We specify these overall template size in inches to map them.
  let overallW, overallH;
  if (state.bookType === 'hardcover') {
    // Standard KDP 6"x9" hardcover template is 14.133" x 10.417"
    overallW = 14.133;
    overallH = 10.417;
  } else {
    // Standard KDP 6"x9" paperback template is 12.635" x 9.25"
    overallW = 12.635;
    overallH = 9.25;
  }

  // Allow custom overrides if user adjusts sliders, but keep default constraints.
  // Overall ratio: 1 inch = scale factor in pixels
  const pxPerInch = imgW / overallW;
  
  const trimW = state.width;
  const trimH = state.height;
  const spineW = state.spineWidth;
  const hg = state.hingeGap;
  const bt = state.boardThickness;
  
  // Calculate horizontal slices
  const spineCenter = imgW / 2;
  const spineWidthPx = spineW * pxPerInch;
  
  const spineStart = Math.max(0, spineCenter - spineWidthPx / 2);
  const spineEnd = Math.min(imgW, spineCenter + spineWidthPx / 2);
  
  // Core text block size
  const trimWidthPx = trimW * pxPerInch;
  const trimHeightPx = trimH * pxPerInch;
  
  // Vertically, templates are centered
  const heightCenter = imgH / 2;
  
  // For hardcover, crop slightly wider on the sides to wrap around cardboard edges
  const bleedOverlap = state.bookType === 'hardcover' ? bt * pxPerInch * 2.5 : 0;
  
  // Core calculations
  const frontStart = spineEnd;
  const frontEnd = Math.min(imgW, frontStart + trimWidthPx + bleedOverlap);
  
  const backEnd = spineStart;
  const backStart = Math.max(0, backEnd - trimWidthPx - bleedOverlap);

  // Height cropping
  const cropH = trimHeightPx + (state.bookType === 'hardcover' ? bt * pxPerInch * 2.5 : 0);
  const cropY = Math.max(0, heightCenter - cropH / 2);

  // Update UI crop preview lines in real-time
  updateCropPreviewUI(spineStart / imgW, spineEnd / imgW, backStart / imgW, frontEnd / imgW);

  // Hinge width in pixels
  const hgPx = state.bookType === 'hardcover' ? hg * pxPerInch : 0;

  // Front side slices
  const frontHingeStart = frontStart;
  const frontHingeEnd = Math.min(frontEnd, frontHingeStart + hgPx);
  const frontBoardStart = frontHingeEnd;
  const frontBoardEnd = frontEnd;

  // Back side slices
  const backHingeEnd = backEnd;
  const backHingeStart = Math.max(backStart, backHingeEnd - hgPx);
  const backBoardEnd = backHingeStart;
  const backBoardStart = backStart;

  // Extract Front Cover Board Texture
  const frontCanvas = document.createElement('canvas');
  frontCanvas.width = 1024;
  frontCanvas.height = 1536;
  const frontCtx = frontCanvas.getContext('2d');
  frontCtx.drawImage(img, frontBoardStart, cropY, Math.max(1, frontBoardEnd - frontBoardStart), cropH, 0, 0, 1024, 1536);

  // Extract Front Hinge Texture
  const frontHingeCanvas = document.createElement('canvas');
  frontHingeCanvas.width = 128;
  frontHingeCanvas.height = 1536;
  const frontHingeCtx = frontHingeCanvas.getContext('2d');
  if (hgPx > 0) {
    frontHingeCtx.drawImage(img, frontHingeStart, cropY, Math.max(1, hgPx), cropH, 0, 0, 128, 1536);
  } else {
    frontHingeCtx.fillStyle = '#cccccc';
    frontHingeCtx.fillRect(0, 0, 128, 1536);
  }

  // Extract Spine Texture
  const spineCanvas = document.createElement('canvas');
  spineCanvas.width = 256;
  spineCanvas.height = 1536;
  const spineCtx = spineCanvas.getContext('2d');
  spineCtx.drawImage(img, spineStart, cropY, Math.max(1, spineEnd - spineStart), cropH, 0, 0, 256, 1536);

  // Extract Back Hinge Texture
  const backHingeCanvas = document.createElement('canvas');
  backHingeCanvas.width = 128;
  backHingeCanvas.height = 1536;
  const backHingeCtx = backHingeCanvas.getContext('2d');
  if (hgPx > 0) {
    backHingeCtx.drawImage(img, backHingeStart, cropY, Math.max(1, hgPx), cropH, 0, 0, 128, 1536);
  } else {
    backHingeCtx.fillStyle = '#cccccc';
    backHingeCtx.fillRect(0, 0, 128, 1536);
  }

  // Extract Back Cover Board Texture
  const backCanvas = document.createElement('canvas');
  backCanvas.width = 1024;
  backCanvas.height = 1536;
  const backCtx = backCanvas.getContext('2d');
  backCtx.drawImage(img, backBoardStart, cropY, Math.max(1, backBoardEnd - backBoardStart), cropH, 0, 0, 1024, 1536);

  // Apply to Three.js textures
  if (state.frontTexture) state.frontTexture.dispose();
  if (state.spineTexture) state.spineTexture.dispose();
  if (state.backTexture) state.backTexture.dispose();
  if (state.frontHingeTexture) state.frontHingeTexture.dispose();
  if (state.backHingeTexture) state.backHingeTexture.dispose();

  state.frontTexture = new THREE.CanvasTexture(frontCanvas);
  state.spineTexture = new THREE.CanvasTexture(spineCanvas);
  state.backTexture = new THREE.CanvasTexture(backCanvas);
  state.frontHingeTexture = new THREE.CanvasTexture(frontHingeCanvas);
  state.backHingeTexture = new THREE.CanvasTexture(backHingeCanvas);

  // Make sure they render crisp
  [state.frontTexture, state.spineTexture, state.backTexture, state.frontHingeTexture, state.backHingeTexture].forEach(tex => {
    if (tex) {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    }
  });
}

// Update the dotted vertical lines in the UI sidebar preview overlay
function updateCropPreviewUI(spineStartPct, spineEndPct, backStartPct, frontEndPct) {
  const guideL = document.querySelector('.guide-left');
  const guideR = document.querySelector('.guide-right');
  const labelBack = document.querySelector('.label-back');
  const labelSpine = document.querySelector('.label-spine');
  const labelFront = document.querySelector('.label-front');
  
  if (guideL && guideR) {
    const leftPct = spineStartPct * 100;
    const rightPct = spineEndPct * 100;
    guideL.style.left = `${leftPct}%`;
    guideR.style.left = `${rightPct}%`;
    
    // Label centers
    if (labelBack) labelBack.style.left = `${(spineStartPct / 2) * 100}%`;
    if (labelSpine) labelSpine.style.left = `${((spineStartPct + spineEndPct) / 2) * 100}%`;
    if (labelFront) labelFront.style.left = `${((spineEndPct + 1) / 2) * 100}%`;
  }
}

// Load high-quality GLB 3D models and simple fallback props into the scene
function create3DProps() {
  if (!propsGroup) return;

  loadedProps = [];
  const loader = new GLTFLoader();

  // -- 1. Load real Khronos GLB Plant model (DiffuseTransmissionPlant) --
  const plantGroup = new THREE.Group();
  plantGroup.position.set(-4.5, 0, -3.0);
  plantGroup.scale.set(2.2, 2.2, 2.2);
  propsGroup.add(plantGroup);
  loadedProps.push({ group: plantGroup, name: 'Plant' });

  loader.load('/plant.glb', (gltf) => {
    const model = gltf.scene;
    model.traverse(child => {
      if (child.isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
    // Center model at base
    const box = new THREE.Box3().setFromObject(model);
    const center = box.getCenter(new THREE.Vector3());
    model.position.set(-center.x, -box.min.y, -center.z);
    plantGroup.add(model);
  }, undefined, (err) => {
    console.warn('plant.glb failed, using fallback', err);
    // Fallback terracotta pot
    const potMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.4, 0.28, 0.7, 16),
      new THREE.MeshStandardMaterial({ color: 0xd97706, roughness: 0.85 })
    );
    potMesh.position.y = 0.35;
    potMesh.castShadow = true;
    plantGroup.add(potMesh);
  });

  // -- 2. Load real Khronos GLB Teacup model (DiffuseTransmissionTeacup) --
  const cupGroup = new THREE.Group();
  cupGroup.position.set(5.0, 0, -2.5);
  cupGroup.scale.set(3.5, 3.5, 3.5);
  propsGroup.add(cupGroup);
  loadedProps.push({ group: cupGroup, name: 'Teacup' });

  loader.load('/teacup.glb', (gltf) => {
    const model = gltf.scene;
    model.traverse(child => {
      if (child.isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
    // Center model at base
    const box = new THREE.Box3().setFromObject(model);
    const center = box.getCenter(new THREE.Vector3());
    model.position.set(-center.x, -box.min.y, -center.z);
    cupGroup.add(model);
  }, undefined, (err) => {
    console.warn('teacup.glb failed, using fallback', err);
    // Fallback white mug
    const mugMat = new THREE.MeshStandardMaterial({ color: 0xfefefe, roughness: 0.15 });
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 0.9, 32), mugMat);
    body.position.y = 0.45;
    body.castShadow = true;
    cupGroup.add(body);
    const handle = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.07, 8, 24, Math.PI), mugMat);
    handle.position.set(-0.35, 0.45, 0);
    handle.rotation.z = Math.PI / 2;
    cupGroup.add(handle);
  });

  // -- 3. Brass Pen (keep procedural - looks fine) --
  const penGroup = new THREE.Group();
  const penGeom = new THREE.CylinderGeometry(0.06, 0.05, 2.2, 12);
  const penMat = new THREE.MeshStandardMaterial({ color: 0xca8a04, metalness: 0.92, roughness: 0.15 });
  const penMesh = new THREE.Mesh(penGeom, penMat);
  penMesh.rotation.x = Math.PI / 2;
  penMesh.rotation.y = 0.4;
  penMesh.castShadow = true;
  penGroup.add(penMesh);
  // Pen tip
  const tipMesh = new THREE.Mesh(
    new THREE.ConeGeometry(0.05, 0.15, 12),
    new THREE.MeshStandardMaterial({ color: 0x1a1a1a, metalness: 0.8, roughness: 0.2 })
  );
  tipMesh.position.z = -1.175;
  tipMesh.rotation.x = -Math.PI / 2;
  penGroup.add(tipMesh);
  penGroup.position.set(1.8, 0.06, 3.2);
  propsGroup.add(penGroup);
  loadedProps.push({ group: penGroup, name: 'Pen' });

  // Hide by default (shown only in wood-angle 3D scene)
  propsGroup.visible = false;
}

// --- 3D BOOK GEOMETRY GENERATORS ---

// Clear existing book mesh group and re-create it based on settings
function rebuildBook() {
  if (!scene) return;
  
  // Remove old group
  if (bookGroup) {
    scene.remove(bookGroup);
    // Recursively dispose geometry and materials
    bookGroup.traverse(child => {
      if (child.isMesh) {
        child.geometry.dispose();
        if (Array.isArray(child.material)) {
          child.material.forEach(m => m.dispose());
        } else {
          child.material.dispose();
        }
      }
    });
  }

  bookGroup = new THREE.Group();
  bookGroup.castShadow = true;
  bookGroup.receiveShadow = true;

  // Render book based on layout type
  if (state.bookType === 'hardcover') {
    createHardcoverMesh();
  } else {
    createPaperbackMesh();
  }

  // Adjust book position based on composition preset
  applyComposition();

  scene.add(bookGroup);
}

// Get cover material — physics-based, per finish type
function getCoverMaterial(texture, isSpine = false) {
  const hasTexture = !!(texture);
  const baseColor = hasTexture ? 0xffffff : 0xbbbbbb;

  if (state.coverFinish === 'glossy') {
    // High-gloss UV-coat: clearcoat + low roughness (laminate gloss)
    return new THREE.MeshPhysicalMaterial({
      color: baseColor,
      map: texture || null,
      roughness: 0.12,
      metalness: 0.0,
      clearcoat: 1.0,
      clearcoatRoughness: 0.04,
      reflectivity: 0.9,
      envMapIntensity: 1.2
    });
  } else if (state.coverFinish === 'textured') {
    // Linen / embossed hardcover cloth
    return new THREE.MeshPhysicalMaterial({
      color: baseColor,
      map: texture || null,
      roughness: 0.88,
      metalness: 0.0,
      bumpMap: linenBumpTexture,
      bumpScale: 0.06,
      clearcoat: 0.05,
      clearcoatRoughness: 0.9
    });
  } else {
    // Soft-touch matte coating (most real paperbacks)
    const matteCoat = state.matteTex || paperBumpTexture;
    return new THREE.MeshPhysicalMaterial({
      color: baseColor,
      map: texture || null,
      roughness: state.bookType === 'paperback' ? 0.82 : 0.70,
      metalness: 0.0,
      bumpMap: state.bookType === 'paperback' ? matteCoat : paperBumpTexture,
      bumpScale: state.bookType === 'paperback' ? 0.018 : 0.010,
      // Soft sheen — paperbacks have a very subtle satin sheen from coating
      sheen: state.bookType === 'paperback' ? 0.08 : 0.0,
      sheenRoughness: 0.9,
      clearcoat: state.bookType === 'paperback' ? 0.12 : 0.04,
      clearcoatRoughness: state.bookType === 'paperback' ? 0.85 : 0.70
    });
  }
}

// Create page edges material with proper paper micro-texture
function getPagesMaterial(isVertical = false) {
  const paperColorHex = paperColors[state.paperColor];
  let edgeColorHex = paperColorHex;
  
  if (state.pageEdgeStyle === 'custom') {
    edgeColorHex = state.customEdgeColor;
  } else if (state.pageEdgeStyle !== 'standard') {
    edgeColorHex = pageEdgeColors[state.pageEdgeStyle];
  }

  const useGilded = state.pageEdgeStyle === 'gold' || state.pageEdgeStyle === 'silver';

  return new THREE.MeshPhysicalMaterial({
    color: edgeColorHex,
    roughness: useGilded ? 0.12 : 0.88,
    metalness: useGilded ? 0.95 : 0.0,
    bumpMap: generatePageEdgeTexture(edgeColorHex, isVertical),
    bumpScale: useGilded ? 0.008 : 0.06,
    clearcoat: useGilded ? 0.5 : 0.0,
    clearcoatRoughness: 0.1
  });
}

// Paperback Generator (continuous box wrap with convex curved spine and cover puff)
function createPaperbackMesh() {
  const w = state.width * INCH_TO_THREE;
  const h = state.height * INCH_TO_THREE;
  const d = state.spineWidth * INCH_TO_THREE;

  // Segmented box for organic deformations
  const bookGeom = new THREE.BoxGeometry(w, h, d, 24, 1, 12);
  
  const posAttr = bookGeom.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < posAttr.count; i++) {
    v.fromBufferAttribute(posAttr, i);
    
    // 1. Spine convex rounding (at the left edge x = -w/2)
    const spineDist = v.x - (-w/2);
    const blendDist = w * 0.2; // blend over 20% of width
    if (spineDist < blendDist) {
      const blendFactor = 1.0 - (spineDist / blendDist);
      const zRatio = v.z / (d / 2); // -1 to 1
      const curveOffset = -0.05 * d * (1.0 - zRatio * zRatio); // max offset at center
      v.x += curveOffset * blendFactor;
    }
    
    // 2. Cover puff (covers bend outward slightly towards the open edge x = +w/2)
    const isCover = Math.abs(Math.abs(v.z) - d/2) < 0.001;
    if (isCover) {
      const openDistFactor = (v.x - (-w/2)) / w; // 0 at spine, 1 at open edge
      const puffOffset = 0.04 * d * Math.pow(openDistFactor, 2); // quadratic flare
      if (v.z > 0) {
        v.z += puffOffset;
      } else {
        v.z -= puffOffset;
      }
    }
    
    posAttr.setXYZ(i, v.x, v.y, v.z);
  }
  bookGeom.computeVertexNormals();

  // Array of materials: [Right, Left, Top, Bottom, Front, Back]
  const matRight = getPagesMaterial(false);
  const matLeft = getCoverMaterial(state.spineTexture); // Spine
  const matTop = getPagesMaterial(true);
  const matBottom = getPagesMaterial(true);
  const matFront = getCoverMaterial(state.frontTexture);
  const matBack = getCoverMaterial(state.backTexture);

  const materials = [
    matRight,  // Page edges (right)
    matLeft,   // Spine (left)
    matTop,    // Page edges (top)
    matBottom, // Page edges (bottom)
    matFront,  // Front Cover
    matBack    // Back Cover
  ];

  const bookMesh = new THREE.Mesh(bookGeom, materials);
  bookMesh.castShadow = true;
  bookMesh.receiveShadow = true;
  
  // Center paperback pivot around bottom-left spine edge for easy rotation
  bookMesh.position.set(w / 2, h / 2, 0);
  bookGroup.add(bookMesh);
}

// Hardcover Generator (distinct cover boards with puff, curved spine board, hinge creases, and concave paper block)
function createHardcoverMesh() {
  const w = state.width * INCH_TO_THREE;
  const h = state.height * INCH_TO_THREE;
  const d = state.spineWidth * INCH_TO_THREE;
  const oh = state.overhang * INCH_TO_THREE;
  const bt = state.boardThickness * INCH_TO_THREE;
  const hg = state.hingeGap * INCH_TO_THREE;

  // 1. PAPER PAGES BLOCK (with realistic concave fore-edge)
  const pagesGeom = new THREE.BoxGeometry(w - 0.05, h, d - 0.02, 12, 1, 12);
  const posAttrPages = pagesGeom.attributes.position;
  const vp = new THREE.Vector3();
  for (let i = 0; i < posAttrPages.count; i++) {
    vp.fromBufferAttribute(posAttrPages, i);
    
    // Concave fore-edge (at the right edge x = (w-0.05)/2)
    const rightEdgeX = (w - 0.05) / 2;
    const edgeDist = rightEdgeX - vp.x;
    const blendDist = w * 0.3; // blend indentation inward
    if (edgeDist < blendDist) {
      const blendFactor = 1.0 - (edgeDist / blendDist);
      const zRatio = vp.z / ((d - 0.02) / 2);
      const concaveIndent = -0.06 * d * (1.0 - zRatio * zRatio); // curve inward
      vp.x += concaveIndent * blendFactor;
    }
    
    posAttrPages.setXYZ(i, vp.x, vp.y, vp.z);
  }
  pagesGeom.computeVertexNormals();

  const pagesRight = getPagesMaterial(false);
  const pagesSpine = new THREE.MeshBasicMaterial({ color: paperColors[state.paperColor] }); // hidden face
  const pagesTop = getPagesMaterial(true);
  const pagesBottom = getPagesMaterial(true);
  
  const pagesMaterials = [
    pagesRight,  // Right
    pagesSpine,  // Left (inside spine)
    pagesTop,    // Top
    pagesBottom, // Bottom
    pagesSpine,  // Front (inside)
    pagesSpine   // Back (inside)
  ];
  
  const pagesMesh = new THREE.Mesh(pagesGeom, pagesMaterials);
  pagesMesh.position.set(w / 2, h / 2, 0);
  pagesMesh.castShadow = true;
  pagesMesh.receiveShadow = true;
  bookGroup.add(pagesMesh);

  // 2. FRONT COVER BOARD (with slight puff/warp outward at the edge)
  const boardW = w + oh - hg;
  const boardH = h + 2 * oh;
  
  const frontGeom = new THREE.BoxGeometry(boardW, boardH, bt, 12, 1, 1);
  const posAttrFront = frontGeom.attributes.position;
  const vf = new THREE.Vector3();
  for (let i = 0; i < posAttrFront.count; i++) {
    vf.fromBufferAttribute(posAttrFront, i);
    const openDistFactor = (vf.x - (-boardW / 2)) / boardW; // 0 to 1
    const puffOffset = 0.025 * d * Math.pow(openDistFactor, 2); // warp outward slightly
    vf.z += puffOffset;
    posAttrFront.setXYZ(i, vf.x, vf.y, vf.z);
  }
  frontGeom.computeVertexNormals();

  const matFrontOuter = getCoverMaterial(state.frontTexture);
  const matInsidePaper = new THREE.MeshStandardMaterial({ 
    color: paperColors[state.paperColor],
    roughness: 0.8 
  });
  
  const frontMaterials = [
    getCoverMaterial(null), // Edges
    getCoverMaterial(null),
    getCoverMaterial(null),
    getCoverMaterial(null),
    matFrontOuter,          // Front cover image
    matInsidePaper          // Inner white backing sheet
  ];
  
  const frontBoard = new THREE.Mesh(frontGeom, frontMaterials);
  frontBoard.position.set(hg + boardW / 2, h / 2, d / 2 + bt / 2);
  frontBoard.castShadow = true;
  frontBoard.receiveShadow = true;
  bookGroup.add(frontBoard);

  // 3. BACK COVER BOARD (with slight puff/warp outward at the edge)
  const backGeom = new THREE.BoxGeometry(boardW, boardH, bt, 12, 1, 1);
  const posAttrBack = backGeom.attributes.position;
  const vb = new THREE.Vector3();
  for (let i = 0; i < posAttrBack.count; i++) {
    vb.fromBufferAttribute(posAttrBack, i);
    const openDistFactor = (vb.x - (-boardW / 2)) / boardW;
    const puffOffset = 0.025 * d * Math.pow(openDistFactor, 2);
    vb.z -= puffOffset; // warp back cover outward (negative Z)
    posAttrBack.setXYZ(i, vb.x, vb.y, vb.z);
  }
  backGeom.computeVertexNormals();

  const matBackOuter = getCoverMaterial(state.backTexture);
  const backMaterials = [
    getCoverMaterial(null), // Edges
    getCoverMaterial(null),
    getCoverMaterial(null),
    getCoverMaterial(null),
    matInsidePaper,         // Inner white backing sheet
    matBackOuter            // Back cover image
  ];
  
  const backBoard = new THREE.Mesh(backGeom, backMaterials);
  backBoard.position.set(hg + boardW / 2, h / 2, -d / 2 - bt / 2);
  backBoard.castShadow = true;
  backBoard.receiveShadow = true;
  bookGroup.add(backBoard);

  // 4. SPINE BOARD (with convex curve)
  const spineGeom = new THREE.BoxGeometry(bt, boardH, d + 2 * bt, 1, 1, 12);
  const posAttrSpine = spineGeom.attributes.position;
  const vs = new THREE.Vector3();
  for (let i = 0; i < posAttrSpine.count; i++) {
    vs.fromBufferAttribute(posAttrSpine, i);
    const isOuter = vs.x < 0;
    if (isOuter) {
      const zRatio = vs.z / ((d + 2 * bt) / 2); // -1 to 1
      const curveOffset = -0.06 * d * (1.0 - zRatio * zRatio);
      vs.x += curveOffset;
    }
    posAttrSpine.setXYZ(i, vs.x, vs.y, vs.z);
  }
  spineGeom.computeVertexNormals();

  const matSpineOuter = getCoverMaterial(state.spineTexture);
  const spineMaterials = [
    matInsidePaper,         // Inner backing
    matSpineOuter,          // Outer Spine design
    getCoverMaterial(null),
    getCoverMaterial(null),
    getCoverMaterial(null),
    getCoverMaterial(null)
  ];
  
  const spineBoard = new THREE.Mesh(spineGeom, spineMaterials);
  spineBoard.position.set(-bt / 2, h / 2, 0);
  spineBoard.castShadow = true;
  spineBoard.receiveShadow = true;
  bookGroup.add(spineBoard);

  // 5. HINGE CREASES — paper-thin planes; never cast shadows (causes self-acne)
  const hingeGeomF = new THREE.BoxGeometry(hg, boardH, 0.008);
  const hingeMatF = getCoverMaterial(state.frontHingeTexture);
  const hingeMatB = getCoverMaterial(state.backHingeTexture);
  
  const frontHinge = new THREE.Mesh(hingeGeomF, hingeMatF);
  frontHinge.position.set(hg / 2, h / 2, d / 2 - 0.005);
  frontHinge.castShadow = false; // paper-thin — would cause self-acne on cover
  frontHinge.receiveShadow = true;
  bookGroup.add(frontHinge);
  
  const backHinge = new THREE.Mesh(hingeGeomF, hingeMatB);
  backHinge.position.set(hg / 2, h / 2, -d / 2 + 0.005);
  backHinge.castShadow = false; // paper-thin — would cause self-acne on cover
  backHinge.receiveShadow = true;
  bookGroup.add(backHinge);
}

// Map presets to their photorealistic backdrops
const presetBackdrops = {
  'clean-flatlay': '/backdrop_clean_flatlay.png',
  'concrete-wall': '/backdrop_concrete_wall.png',
  'hands-blue': '/backdrop_hands_blue.png',
  'hands-sky': '/backdrop_hands_sky.png'
};

// Automatically positions book and camera to match backdrop photography angles
function alignPresetCamera() {
  if (!bookGroup || !camera || !controls) return;

  const pre = state.preset;
  const w = state.width * INCH_TO_THREE;
  const h = state.height * INCH_TO_THREE;
  const d = state.spineWidth * INCH_TO_THREE;
  const bt = state.boardThickness * INCH_TO_THREE;
  const thickness = state.bookType === 'hardcover' ? (d + 2 * bt) : d;

  // Lock camera orbit controls for hands-held presets to maintain perspective alignment
  if (pre === 'hands-blue' || pre === 'hands-sky') {
    controls.enabled = false;
  } else {
    controls.enabled = true;
  }

  // Reset book transformations
  bookGroup.position.set(0, 0, 0);
  bookGroup.rotation.set(0, 0, 0);

  if (pre === 'clean-flatlay') {
    state.composition = 'lying';
    
    // Position book flat on table, matching the angle of the wood grain
    bookGroup.rotation.x = -Math.PI / 2;
    bookGroup.rotation.z = Math.PI / 6;
    bookGroup.position.set(-0.3, thickness / 2, 0.2);

    // Setup camera to match 3/4 perspective of backdrop image
    camera.position.set(2.2, 3.8, 4.4);
    controls.target.set(0, 0.2, 0);
    controls.update();

  } else if (pre === 'concrete-wall') {
    state.composition = 'standing';
    
    // Tilted back leaning against the sandstone wall
    bookGroup.rotation.x = -0.15;
    bookGroup.rotation.y = -0.3;
    bookGroup.rotation.z = 0;
    bookGroup.position.set(-w / 2 - 0.2, 0.05, -0.2);

    // Low angle shot looking up at leaning book
    camera.position.set(2.6, 2.0, 4.5);
    controls.target.set(0, 1.2, 0);
    controls.update();

  } else if (pre === 'hands-blue') {
    state.composition = 'standing';
    
    // Position book in hands center at correct tilt
    bookGroup.rotation.x = 0.22;
    bookGroup.rotation.y = -0.52;
    bookGroup.rotation.z = -0.15;
    bookGroup.position.set(-w / 2 - 0.2, 0.45, 0.15);

    // Zoom camera out (distance = 13.5) to match the book size in background image
    camera.position.set(0.0, 1.8, 13.5);
    controls.target.set(-0.2, 1.3, 0);
    controls.update();

  } else if (pre === 'hands-sky') {
    state.composition = 'standing';
    
    // Angle the book model facing forward held up against sky
    bookGroup.rotation.x = 0.02;
    bookGroup.rotation.y = -0.05;
    bookGroup.rotation.z = 0.0;
    bookGroup.position.set(-w / 2, 0.95, 0.0);

    // Zoom camera out (distance = 13.0) to match sky background book
    camera.position.set(0.0, 2.2, 13.0);
    controls.target.set(0, 1.6, 0);
    controls.update();

  } else if (pre === 'wood-angle') {
    state.composition = 'lying';
    
    bookGroup.rotation.x = -Math.PI / 2;
    bookGroup.rotation.z = Math.PI / 6;
    bookGroup.position.set(-0.3, thickness / 2, 0.2);

    camera.position.set(2.4, 3.5, 4.5);
    controls.target.set(0, 0, 0);
    controls.update();

  } else if (pre === 'studio' || pre === 'midnight-mood') {
    state.composition = 'standing';
    bookGroup.position.set(-w / 2, 0, 0);
    
    camera.position.set(4.5, 3.5, 5.0);
    controls.target.set(0, 0.8, 0);
    controls.update();
  }
}

// --- BOOK COMPOSITION PLACEMENTS ---
function applyComposition() {
  alignPresetCamera();
}

// --- PHOTOSHOOT PRESETS & LIGHTING ---

// Set up floor and environment based on preset
function applyPreset() {
  if (!scene) return;

  const pre = state.preset;
  const container = document.getElementById('canvas-container');
  
  // Clear any existing CSS backdrops
  if (container) {
    container.style.backgroundImage = 'none';
    container.style.backgroundColor = 'transparent';
  }

  // Adjust book position based on current preset to match perspective of the backdrop
  let isPhotoBackdrop = false;
  let bgColor = new THREE.Color('#f0f0f5');
  let floorColor = '#e5e5eb';
  let floorMetal = 0.05;
  let floorRough = 0.8;
  
  // Hide overlays/props by default
  if (leafShadowPlane) leafShadowPlane.visible = false;
  if (wallShadowPlane) wallShadowPlane.visible = false;
  if (propsGroup) propsGroup.visible = false;

  if (pre === 'studio') {
    bgColor = new THREE.Color('#f0f0f5');
    floorColor = '#e5e5eb';
    floorMetal = 0.05;
    floorRough = 0.8;
  } else if (pre === 'midnight-mood') {
    bgColor = new THREE.Color('#0a0812');
    floorColor = '#0f0e1a';
    floorMetal = 0.9;
    floorRough = 0.25;
  } else if (pre === 'wood-angle') {
    // 3D Table Studio - fully modeled in 3D!
    bgColor = new THREE.Color('#efebe9'); // Warm cozy studio wall
    floorColor = '#ffffff'; // White base color under wood texture map
    floorMetal = 0.1;
    floorRough = 0.45;
    if (propsGroup) propsGroup.visible = true;
    // leaf shadow plane is NEVER a shadow caster (it only acts as stencil in photo mode)
    if (leafShadowPlane) leafShadowPlane.visible = false;
  } else {
    // It's a photorealistic photo backdrop!
    isPhotoBackdrop = true;
    const bgUrl = presetBackdrops[pre];
    if (container && bgUrl) {
      container.style.backgroundImage = `url('${bgUrl}')`;
      container.style.backgroundSize = 'cover';
      container.style.backgroundPosition = 'center';
    }
  }

  // Update Scene Background
  if (isPhotoBackdrop) {
    scene.background = null; // transparent WebGL canvas
    if (scene.fog) scene.fog.density = 0.0;
  } else {
    scene.background = bgColor;
    if (scene.fog) {
      scene.fog.color = bgColor;
      scene.fog.density = 0.0; // disable fog to keep colors rich and crisp
    }
  }

  // Update Floor Material (use ShadowMaterial for photo backdrops to catch shadow overlay)
  if (floorPlane) {
    floorPlane.material.dispose();
    if (isPhotoBackdrop) {
      floorPlane.material = new THREE.ShadowMaterial({ opacity: 0.55 });
    } else if (pre === 'wood-angle') {
      // Map wood texture canvas to the 3D desk floor
      floorPlane.material = new THREE.MeshStandardMaterial({
        color: new THREE.Color(floorColor),
        map: generateWoodTexture(),
        roughness: floorRough,
        metalness: floorMetal
      });
    } else {
      floorPlane.material = new THREE.MeshStandardMaterial({
        color: new THREE.Color(floorColor),
        roughness: floorRough,
        metalness: floorMetal
      });
    }
    floorPlane.receiveShadow = true;
    floorPlane.castShadow = false; // floor never casts — only receives
  }

  // Handle vertical wall shadow catcher visibility (leaning wall scene)
  if (wallShadowPlane) {
    if (pre === 'concrete-wall') {
      wallShadowPlane.visible = true;
      wallShadowPlane.material.opacity = 0.45;
    } else {
      wallShadowPlane.visible = false;
    }
  }

  // Align composition and camera angles for each preset to fit the background image perfectly
  alignPresetCamera();

  // Apply real-time hands chroma-key extraction overlay
  applyForegroundOverlay();

  // Setup Lights
  updateLights();
}

// Procedural real-time hands extraction (Skin + Dark Clothing chroma-key overlay)
const overlayCache = {};
function applyForegroundOverlay() {
  const pre = state.preset;
  const overlayImg = document.getElementById('foreground-overlay');
  if (!overlayImg) return;

  if (pre !== 'hands-blue' && pre !== 'hands-sky') {
    overlayImg.classList.add('hidden');
    return;
  }

  if (overlayCache[pre]) {
    overlayImg.src = overlayCache[pre];
    overlayImg.classList.remove('hidden');
    return;
  }

  const bgUrl = presetBackdrops[pre];
  if (!bgUrl) return;

  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);

    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imgData.data;

    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];

      // Skin detection filter (warm peach/orange hand pixels)
      const isSkin = r > 60 && g > 40 && b > 20 && r > g && (r - g) > 12;
      
      // Clothing detection (neutral dark grey sleeves)
      const isClothing = r < 120 && g < 120 && b < 120 && Math.abs(r - g) < 20 && Math.abs(g - b) < 20;

      if (!isSkin && !isClothing) {
        data[i + 3] = 0; // Make other pixels (sky, blue backdrop, teal book) transparent
      }
    }

    ctx.putImageData(imgData, 0, 0);
    const dataUrl = canvas.toDataURL('image/png');
    overlayCache[pre] = dataUrl;
    overlayImg.src = dataUrl;
    overlayImg.classList.remove('hidden');
  };
  img.src = bgUrl;
}

// Re-configure lights based on selected preset, intensity, and direction
function updateLights() {
  if (!scene) return;

  // Dispose existing lights
  Object.keys(lights).forEach(k => scene.remove(lights[k]));
  lights = {};

  const pre = state.preset;
  const rad = (state.lightRotation * Math.PI) / 180;
  const intensity = state.lightIntensity;
  const distance = 8.0;
  const lx = Math.cos(rad) * distance;
  const lz = Math.sin(rad) * distance;

  // Scene centre target — all key lights point here so shadow frustum is centred on objects
  const sceneTarget = new THREE.Object3D();
  sceneTarget.position.set(0, 1.0, 0);
  scene.add(sceneTarget);

  function makeDir(color, mul, px, py, pz) {
    const d = new THREE.DirectionalLight(color, mul * intensity);
    d.position.set(px, py, pz);
    d.target = sceneTarget;
    return d;
  }

  if (pre === 'studio' || pre === 'hands-blue') {
    lights.ambient = new THREE.AmbientLight(0xffffff, 0.6 * intensity);
    const key = makeDir(0xffffff, 1.35, lx, 8.0, lz);
    configureShadows(key, 7);
    lights.key = key;
    lights.fill = makeDir(0xe2e8f0, 0.4, -lx, 3.0, -lz);
    const rim = new THREE.SpotLight(0xffffff, 0.7 * intensity, 15, Math.PI / 6, 0.5, 1);
    rim.position.set(0, 5, -6);
    lights.rim = rim;

  } else if (pre === 'clean-flatlay') {
    lights.ambient = new THREE.AmbientLight(0xfffaf0, 0.75 * intensity);
    const key = makeDir(0xfffdf9, 1.1, 2.0, 8.0, 3.0);
    configureShadows(key, 8);
    lights.key = key;
    lights.fill = makeDir(0xffffff, 0.3, -2.0, 3.0, -3.0);

  } else if (pre === 'concrete-wall') {
    lights.ambient = new THREE.AmbientLight(0xfff7e6, 0.3 * intensity);
    const key = makeDir(0xffeedd, 2.2, lx, 4.0, lz);
    configureShadows(key, 9);
    key.shadow.radius = state.shadowSoftness * 1.5;
    lights.key = key;
    lights.fill = makeDir(0xe0e7ff, 0.4, -lx, 2.0, -lz);

  } else if (pre === 'hands-sky') {
    lights.ambient = new THREE.AmbientLight(0xdbeafe, 0.65 * intensity);
    const key = makeDir(0xffffff, 1.9, 2.0, 9.0, 1.0);
    configureShadows(key, 7);
    lights.key = key;
    lights.fill = makeDir(0xbfdbfe, 0.5, -2.0, 3.0, -2.0);

  } else if (pre === 'midnight-mood') {
    lights.ambient = new THREE.AmbientLight(0x181829, 0.25 * intensity);
    const key = makeDir(0xd8b4fe, 0.75, lx, 6.0, lz);
    configureShadows(key, 7);
    lights.key = key;
    lights.blueRim    = makeDir(0x06b6d4, 1.9, -5, 4, -4);
    lights.magentaRim = makeDir(0xec4899, 1.6,  5, 3, -4);

  } else if (pre === 'wood-angle') {
    lights.ambient = new THREE.AmbientLight(0xffecd9, 0.45 * intensity);
    const key = makeDir(0xfff1e2, 1.45, lx, 7.0, lz);
    configureShadows(key, 10); // wider for full 3D table scene
    lights.key = key;

    // Warm desk spotlight above centre — properly configured with shadow
    const spot = new THREE.SpotLight(0xffdcb3, 1.8 * intensity, 14, Math.PI / 4.5, 0.35, 0.8);
    spot.position.set(1, 6, 2);
    spot.target = sceneTarget;
    spot.castShadow = true;
    spot.shadow.mapSize.set(2048, 2048);
    spot.shadow.camera.near = 0.5;
    spot.shadow.camera.far = 20;
    spot.shadow.bias = -0.0004;
    spot.shadow.normalBias = 0.05;
    spot.shadow.radius = Math.max(1.5, state.shadowSoftness * 5.0);
    lights.spot = spot;
  }

  Object.keys(lights).forEach(k => scene.add(lights[k]));
}

// Shadow configuration — proper physics-based PCF shadow maps
// range: half-size of the orthographic frustum (smaller = sharper, must cover scene)
function configureShadows(light, range = 8.0) {
  light.castShadow = true;
  // 4K shadow maps for crisp detail
  light.shadow.mapSize.width  = 4096;
  light.shadow.mapSize.height = 4096;
  light.shadow.camera.near = 0.5;
  light.shadow.camera.far  = 35;
  
  // Orthographic frustum centred on scene (target is always set to scene centre)
  light.shadow.camera.left   = -range;
  light.shadow.camera.right  =  range;
  light.shadow.camera.top    =  range;
  light.shadow.camera.bottom = -range;
  
  // normalBias eliminates self-shadowing (acne) on thin surfaces like book covers/hinges
  // bias pulls shadow slightly towards caster to avoid detachment (peter-panning)
  light.shadow.bias       = -0.0002;
  light.shadow.normalBias =  0.04;    // higher value = no acne on flat/thin surfaces
  // PCFSoft radius for penumbra softness
  light.shadow.radius = Math.max(1.0, state.shadowSoftness * 5.0);
}

// --- INITIALIZATION ---

function init() {
  const container = document.getElementById('canvas-container');
  const canvas = document.getElementById('webgl-canvas');
  
  if (!container || !canvas) return;

  const w = container.clientWidth;
  const h = container.clientHeight;

  // 1. WebGL Renderer — high quality PBR
  renderer = new THREE.WebGLRenderer({
    canvas: canvas,
    antialias: true,
    alpha: true,
    preserveDrawingBuffer: true,
    powerPreference: 'high-performance'
  });
  renderer.setSize(w, h);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap; // Smooth PCF
  renderer.physicallyCorrectLights = true;          // Physics-accurate light attenuation
  
  // Filmic tone mapping + proper color space for PBR
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  // 2. Scene setup
  scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2('#f0f0f5', 0.0); // disabled by default to prevent washed out colors

  // 3. Camera
  camera = new THREE.PerspectiveCamera(state.fov, w / h, 0.1, 100);
  camera.position.set(4.5, 3.5, 5.0); // nice default 3/4 isometric position

  // 4. Orbit Controls
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;
  controls.minDistance = 0.5;
  controls.maxDistance = 50.0;
  controls.target.set(0, 0.8, 0);

  // 5. Generate cache textures
  linenBumpTexture = generateLinenBumpTexture();
  paperBumpTexture = generatePaperBumpTexture();
  state.matteTex = generateMatteCoatTexture(); // paperback matte coating micro-fiber

  // 6. Floor Plane
  const floorGeom = new THREE.PlaneGeometry(100, 100);
  floorPlane = new THREE.Mesh(floorGeom, new THREE.MeshStandardMaterial());
  floorPlane.rotation.x = -Math.PI / 2;
  floorPlane.position.y = 0;
  floorPlane.receiveShadow = true;
  scene.add(floorPlane);

  // 6b. Wall Shadow Catcher (vertical plane behind the book pivot to receive sandstone wall shadows)
  const wallGeom = new THREE.PlaneGeometry(100, 100);
  wallShadowPlane = new THREE.Mesh(wallGeom, new THREE.ShadowMaterial({ opacity: 0.4 }));
  wallShadowPlane.position.set(0, 0, -0.6); // placed slightly behind book
  wallShadowPlane.receiveShadow = true;
  wallShadowPlane.visible = false;
  scene.add(wallShadowPlane);

  // 6c. 3D Props Group
  propsGroup = new THREE.Group();
  scene.add(propsGroup);
  create3DProps();

  // 7. Studio Ground Grid — a reference plane grid (like Blender's)
  //    Each cell = 1 Three.js unit = 1 inch. Helps see proportions and align objects.
  gridHelper = new THREE.GridHelper(60, 60, 0x7c3aed, 0x252535);
  gridHelper.position.y = 0.003;
  gridHelper.visible = false;
  scene.add(gridHelper);

  // World Axes Helper — shows X (red), Y (green), Z (blue) axis arrows
  window._axesHelper = new THREE.AxesHelper(3);
  window._axesHelper.visible = false;
  scene.add(window._axesHelper);

  // 8. Leaf shadow caster plane — NEVER casts shadows (causes floor stripe artifacts)
  const stencilCanvas = generateLeafStencilCanvas();
  const leafTex = new THREE.CanvasTexture(stencilCanvas);
  const leafMat = new THREE.MeshBasicMaterial({
    alphaMap: leafTex,
    transparent: true,
    opacity: 0,
    side: THREE.DoubleSide
  });
  const leafGeom = new THREE.PlaneGeometry(3, 3);
  leafShadowPlane = new THREE.Mesh(leafGeom, leafMat);
  leafShadowPlane.castShadow = false; // NEVER cast — causes stripe artifacts on floor
  leafShadowPlane.visible = false;
  scene.add(leafShadowPlane);

  // Load saved state (settings only — no 3D objects yet)
  const _savedData = loadSavedData();
  if (_savedData && _savedData.state) {
    Object.assign(state, _savedData.state);
  }

  // Apply default lighting preset & build book shape using (possibly restored) state
  applyPreset();
  rebuildBook();

  // Restore saved 3D object transforms (positions, rotations, scales, visibility)
  applySavedTransforms(_savedData);

  // Expose for later GLB async loads (GLB groups exist, transforms apply immediately)
  window._savedData = _savedData;

  // Apply grid visibility from saved state
  if (gridHelper) gridHelper.visible = state.showGrid;
  if (window._axesHelper) window._axesHelper.visible = state.showGrid;

  // 9. Resize handler
  window.addEventListener('resize', onWindowResize);

  // Start Frame render loop
  animate();
}

function animate() {
  requestAnimationFrame(animate);
  
  if (controls) controls.update();
  if (renderer && scene && camera) renderer.render(scene, camera);
}

function onWindowResize() {
  const container = document.getElementById('canvas-container');
  if (!container) return;
  const w = container.clientWidth;
  const h = container.clientHeight;
  
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}

// --- CONTROLLER EVENTS & LISTENERS ---

document.addEventListener('DOMContentLoaded', () => {
  init();

  // ============================================================
  //  RESTORE UI FROM SAVED STATE (must run right after init())
  // ============================================================
  (function syncUIFromState() {
    // Book type radio
    document.querySelectorAll('input[name="book-type"]').forEach(r => {
      r.checked = r.value === state.bookType;
    });
    // Dimension inputs
    document.getElementById('input-width').value = state.width;
    document.getElementById('input-height').value = state.height;
    document.getElementById('input-spine').value = state.spineWidth;
    document.getElementById('spine-val').textContent = state.spineWidth.toFixed(3) + '"';
    document.getElementById('input-pages').value = state.pages;
    document.getElementById('pages-val').textContent = state.pages;
    // Materials
    document.getElementById('select-finish').value = state.coverFinish;
    document.getElementById('select-paper').value = state.paperColor;
    // Edge style highlight
    document.querySelectorAll('.edge-dot').forEach(d => {
      d.style.border = d.dataset.edge === state.pageEdgeStyle ? '2px solid #7c3aed' : '';
    });
    document.getElementById('input-edge-color').value = state.customEdgeColor;
    // Lighting
    document.getElementById('input-light-intensity').value = state.lightIntensity;
    document.getElementById('intensity-val').textContent = state.lightIntensity.toFixed(1) + 'x';
    document.getElementById('input-light-rotation').value = state.lightRotation;
    document.getElementById('rotation-val').textContent = state.lightRotation + '°';
    document.getElementById('input-shadow-softness').value = state.shadowSoftness;
    // Camera
    document.getElementById('input-fov').value = state.fov;
    const fovTxt = state.fov < 30 ? `${state.fov}° (Telephoto)` : state.fov > 55 ? `${state.fov}° (Wide Angle)` : `${state.fov}° (Portrait)`;
    document.getElementById('fov-val').textContent = fovTxt;
    const dofEl = document.getElementById('input-dof');
    if (dofEl) { dofEl.value = state.dof; document.getElementById('dof-val').textContent = state.dof > 0 ? state.dof + '%' : 'Off'; }
    // Export
    document.getElementById('select-export-bg').value = state.exportBg;
    document.getElementById('select-export-scale').value = String(state.exportScale);
    // Active preset card
    document.querySelectorAll('.preset-card').forEach(c => {
      c.classList.toggle('active', c.dataset.preset === state.preset);
    });
    // Shadow softness label
    const ss = state.shadowSoftness;
    const ssText = ss < 0.2 ? 'Ultra Sharp' : ss < 0.4 ? 'Sharp' : ss > 1.0 ? 'Very Soft' : ss > 0.7 ? 'Soft' : 'Medium';
    document.getElementById('shadow-val').textContent = ssText;
    // Grid button active state
    const tgBtn = document.getElementById('toggle-grid-btn');
    if (tgBtn) tgBtn.classList.toggle('active', !!state.showGrid);
  })();
  // ============================================================

  // ============================================================
  //  SCENE OUTLINER + TRANSFORM INSPECTOR
  // ============================================================

  // Registry of all scene objects — populated here and refreshed
  // when new props are loaded by create3DProps()
  const ICONS = {
    Book: '📖', Plant: '🌿', Teacup: '☕', Pen: '🖊️',
    Floor: '⬜', Wall: '🧱'
  };

  // Selection state
  let selectedEntry = null;      // { id, name, group, locked, visible, defaultPos, defaultRot, defaultScale }
  let selectionBox = null;       // THREE.BoxHelper for outline

  // Build the registry from current scene objects
  function buildRegistry() {
    const reg = [];
    if (bookGroup) {
      reg.push({
        id: 'book', name: 'Book', group: bookGroup,
        locked: false, visible: true,
        defaultPos: bookGroup.position.clone(),
        defaultRot: bookGroup.rotation.clone(),
        defaultScale: bookGroup.scale.clone()
      });
    }
    loadedProps.forEach(p => {
      reg.push({
        id: p.name.toLowerCase(), name: p.name, group: p.group,
        locked: false, visible: p.group.visible,
        defaultPos: p.group.position.clone(),
        defaultRot: p.group.rotation.clone(),
        defaultScale: p.group.scale.clone()
      });
    });
    if (floorPlane) {
      reg.push({
        id: 'floor', name: 'Floor', group: floorPlane,
        locked: true, visible: true,
        defaultPos: floorPlane.position.clone(),
        defaultRot: floorPlane.rotation.clone(),
        defaultScale: floorPlane.scale.clone()
      });
    }
    return reg;
  }

  let sceneRegistry = [];

  // Render the outliner list
  function renderOutliner() {
    sceneRegistry = buildRegistry();
    const list = document.getElementById('outliner-list');
    if (!list) return;
    list.innerHTML = '';

    sceneRegistry.forEach(entry => {
      const row = document.createElement('div');
      row.className = 'outliner-row' +
        (selectedEntry && selectedEntry.id === entry.id ? ' selected' : '') +
        (!entry.visible ? ' hidden-obj' : '');
      row.dataset.id = entry.id;

      // Icon
      const icon = document.createElement('span');
      icon.className = 'outliner-icon';
      icon.textContent = ICONS[entry.name] || '📦';

      // Name
      const name = document.createElement('span');
      name.className = 'outliner-row-name';
      name.textContent = entry.name;

      // Actions: visibility toggle + lock toggle
      const actions = document.createElement('div');
      actions.className = 'outliner-actions';

      const visBtn = document.createElement('button');
      visBtn.className = 'outliner-btn' + (entry.visible ? '' : '');
      visBtn.title = entry.visible ? 'Hide' : 'Show';
      visBtn.textContent = entry.visible ? '👁' : '🚫';
      visBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        entry.visible = !entry.visible;
        entry.group.visible = entry.visible;
        renderOutliner();
      });

      const lockBtn = document.createElement('button');
      lockBtn.className = 'outliner-btn' + (entry.locked ? ' active' : '');
      lockBtn.title = entry.locked ? 'Unlock' : 'Lock position';
      lockBtn.textContent = entry.locked ? '🔒' : '🔓';
      lockBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        entry.locked = !entry.locked;
        renderOutliner();
      });

      actions.append(visBtn, lockBtn);
      row.append(icon, name, actions);

      // Click = select object
      row.addEventListener('click', () => selectEntry(entry));

      list.appendChild(row);

      // Divider before floor
      if (entry.id === (sceneRegistry[sceneRegistry.length - 2]?.id)) {
        const div = document.createElement('div');
        div.className = 'outliner-divider';
        list.appendChild(div);
      }
    });
  }

  // Select an entry: highlight with BoxHelper + show inspector
  function selectEntry(entry) {
    selectedEntry = entry;

    // Update BoxHelper outline
    if (selectionBox) { scene.remove(selectionBox); selectionBox = null; }
    if (entry && entry.group) {
      selectionBox = new THREE.BoxHelper(entry.group, 0x7c3aed);
      scene.add(selectionBox);
    }

    // Show / populate inspector
    const inspector = document.getElementById('transform-inspector');
    const inspName = document.getElementById('inspector-name');
    const inspIcon = document.getElementById('inspector-icon');
    if (!inspector) return;

    if (entry) {
      inspector.classList.remove('hidden');
      inspName.textContent = entry.name;
      inspIcon.textContent = ICONS[entry.name] || '📦';
      syncInspectorFromObject(entry);
    } else {
      inspector.classList.add('hidden');
    }

    renderOutliner();
  }

  // Write 3D object transform values into inspector inputs
  const RAD2DEG = 180 / Math.PI;
  const DEG2RAD = Math.PI / 180;

  function syncInspectorFromObject(entry) {
    if (!entry) return;
    const g = entry.group;
    const px = document.getElementById('inp-px');
    const py = document.getElementById('inp-py');
    const pz = document.getElementById('inp-pz');
    const rx = document.getElementById('inp-rx');
    const ry = document.getElementById('inp-ry');
    const rz = document.getElementById('inp-rz');
    const sc = document.getElementById('inp-s');
    if (!px) return;
    px.value = g.position.x.toFixed(2);
    py.value = g.position.y.toFixed(2);
    pz.value = g.position.z.toFixed(2);
    rx.value = (g.rotation.x * RAD2DEG).toFixed(1);
    ry.value = (g.rotation.y * RAD2DEG).toFixed(1);
    rz.value = (g.rotation.z * RAD2DEG).toFixed(1);
    sc.value = g.scale.x.toFixed(3);
  }

  // Wire inspector inputs → 3D object
  function wireInspectorInputs() {
    const bind = (id, applyFn) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('input', () => {
        if (!selectedEntry) return;
        applyFn(selectedEntry.group, parseFloat(el.value) || 0);
        if (selectionBox) selectionBox.update();
      });
    };
    bind('inp-px', (g, v) => g.position.x = v);
    bind('inp-py', (g, v) => g.position.y = v);
    bind('inp-pz', (g, v) => g.position.z = v);
    bind('inp-rx', (g, v) => g.rotation.x = v * DEG2RAD);
    bind('inp-ry', (g, v) => g.rotation.y = v * DEG2RAD);
    bind('inp-rz', (g, v) => g.rotation.z = v * DEG2RAD);
    bind('inp-s',  (g, v) => g.scale.setScalar(Math.max(0.01, v)));

    // Reset button
    const resetBtn = document.getElementById('inspector-reset-btn');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        if (!selectedEntry) return;
        const g = selectedEntry.group;
        g.position.copy(selectedEntry.defaultPos);
        g.rotation.copy(selectedEntry.defaultRot);
        g.scale.copy(selectedEntry.defaultScale);
        syncInspectorFromObject(selectedEntry);
        if (selectionBox) selectionBox.update();
        showToast(`↺ ${selectedEntry.name} transform reset`);
      });
    }
  }

  // Outliner toggle button
  const toggleOutlinerBtn = document.getElementById('toggle-outliner-btn');
  const outlinerPanel = document.getElementById('scene-outliner');
  const outlinerCloseBtn = document.getElementById('outliner-close-btn');

  if (toggleOutlinerBtn) {
    toggleOutlinerBtn.addEventListener('click', () => {
      outlinerPanel.style.display = outlinerPanel.style.display === 'none' ? 'block' : 'none';
    });
  }
  if (outlinerCloseBtn) {
    outlinerCloseBtn.addEventListener('click', () => {
      outlinerPanel.style.display = 'none';
    });
  }

  // Click outside deselects
  document.getElementById('webgl-canvas')?.addEventListener('pointerdown', (e) => {
    // Only deselect on right-click or click on empty space (handled by drag system already)
  });

  // Initial render after a short delay for props to register
  setTimeout(() => {
    renderOutliner();
    wireInspectorInputs();
  }, 500);

  // Refresh outliner + sync inspector every 500ms (catches async GLB loads)
  setInterval(() => {
    renderOutliner();
    if (selectedEntry) {
      syncInspectorFromObject(selectedEntry);
      if (selectionBox) selectionBox.update();
    }
  }, 600);

  // Expose selectEntry globally so drag system can call it on click
  window.__selectSceneObj = (name) => {
    sceneRegistry = buildRegistry();
    const found = sceneRegistry.find(e => e.name === name);
    if (found) selectEntry(found);
  };

  // Patch the drag findTopGroup callback to auto-select in outliner too
  // This is called from the pointerdown handler via the existing drag system
  window.__onDragStart = (label) => {
    sceneRegistry = buildRegistry();
    const found = sceneRegistry.find(e => e.name === label);
    if (found && found !== selectedEntry) selectEntry(found);
  };

  // ============================================================

  const fileUpload = document.getElementById('cover-upload');
  const dropZone = document.getElementById('drop-zone');
  const previewWrapper = document.getElementById('cover-preview-wrapper');
  const previewImg = document.getElementById('cover-preview-img');
  const removeCoverBtn = document.getElementById('remove-cover-btn');
  const loadDemoBtn = document.getElementById('load-demo-btn');
  const exportBtn = document.getElementById('export-png-btn');
  
  const bookTypeRadios = document.querySelectorAll('input[name="book-type"]');
  const inputWidth = document.getElementById('input-width');
  const inputHeight = document.getElementById('input-height');
  const inputSpine = document.getElementById('input-spine');
  const spineVal = document.getElementById('spine-val');
  const inputPages = document.getElementById('input-pages');
  const pagesVal = document.getElementById('pages-val');
  
  const selectFinish = document.getElementById('select-finish');
  const selectPaper = document.getElementById('select-paper');
  const edgeDots = document.querySelectorAll('.edge-dot');
  const customEdgeTrigger = document.getElementById('custom-edge-trigger');
  const customEdgeColorInput = document.getElementById('input-edge-color');
  
  const presetCards = document.querySelectorAll('.preset-card');
  const inputIntensity = document.getElementById('input-light-intensity');
  const intensityVal = document.getElementById('intensity-val');
  const inputRotation = document.getElementById('input-light-rotation');
  const rotationVal = document.getElementById('rotation-val');
  const inputShadow = document.getElementById('input-shadow-softness');
  const shadowVal = document.getElementById('shadow-val');
  const inputFov = document.getElementById('input-fov');
  const fovVal = document.getElementById('fov-val');
  
  const camButtons = document.querySelectorAll('.camera-presets button');
  const resetCamBtn = document.getElementById('reset-cam-btn');
  const toggleGridBtn = document.getElementById('toggle-grid-btn');
  
  const selectExportBg = document.getElementById('select-export-bg');
  const selectExportScale = document.getElementById('select-export-scale');
  
  const spinner = document.getElementById('spinner');

  // Load a file wrapper into state and trigger rebuilds
  function loadCoverImage(src) {
    spinner.classList.remove('hidden');
    
    state.coverImageSrc = src;
    const img = new Image();
    img.onload = () => {
      state.coverImage = img;
      previewImg.src = src;
      previewWrapper.classList.remove('hidden');
      dropZone.classList.add('hidden');
      
      // Calculate crop & rebuild 3D book
      cropCoverWrap();
      rebuildBook();
      
      spinner.classList.add('hidden');
      showToast('📖 Cover design loaded and mapped successfully.');
    };
    img.onerror = () => {
      spinner.classList.add('hidden');
      showToast('❌ Error loading cover image texture.');
    };
    img.src = src;
  }

  // Handle file input (image or PDF)
  async function handleFileInput(file) {
    if (!file) return;
    
    spinner.classList.remove('hidden');
    showToast('📄 Reading cover PDF / Image...');
    
    try {
      if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
        const reader = new FileReader();
        reader.onload = async (event) => {
          try {
            const arrayBuffer = event.target.result;
            // Set worker source
            pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.worker.min.js';
            const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
            const page = await pdf.getPage(1);
            
            // Render at high resolution (3.0x scale)
            const viewport = page.getViewport({ scale: 3.0 });
            const canvas = document.createElement('canvas');
            canvas.width = viewport.width;
            canvas.height = viewport.height;
            const ctx = canvas.getContext('2d');
            
            const renderContext = {
              canvasContext: ctx,
              viewport: viewport
            };
            
            await page.render(renderContext).promise;
            
            const srcDataUrl = canvas.toDataURL('image/png');
            loadCoverImage(srcDataUrl);
          } catch (err) {
            console.error(err);
            spinner.classList.add('hidden');
            showToast('❌ Failed to parse PDF page cover.');
          }
        };
        reader.readAsArrayBuffer(file);
      } else if (file.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = (event) => {
          loadCoverImage(event.target.result);
        };
        reader.readAsDataURL(file);
      } else {
        spinner.classList.add('hidden');
        showToast('❌ Unsupported file type. Please upload a PDF or Image.');
      }
    } catch (e) {
      console.error(e);
      spinner.classList.add('hidden');
      showToast('❌ Error reading uploaded file.');
    }
  }

  // File Upload Handlers
  fileUpload.addEventListener('change', (e) => {
    const file = e.target.files[0];
    handleFileInput(file);
  });

  // Drag and Drop
  ['dragenter', 'dragover'].forEach(name => {
    dropZone.addEventListener(name, (e) => {
      e.preventDefault();
      dropZone.classList.add('drag-over');
    }, false);
  });

  ['dragleave', 'drop'].forEach(name => {
    dropZone.addEventListener(name, (e) => {
      e.preventDefault();
      dropZone.classList.remove('drag-over');
    }, false);
  });

  dropZone.addEventListener('drop', (e) => {
    const file = e.dataTransfer.files[0];
    handleFileInput(file);
  });

  // Remove Cover design
  removeCoverBtn.addEventListener('click', () => {
    state.coverImage = null;
    state.coverImageSrc = null;
    if (state.frontTexture) state.frontTexture.dispose();
    if (state.spineTexture) state.spineTexture.dispose();
    if (state.backTexture) state.backTexture.dispose();
    if (state.frontHingeTexture) state.frontHingeTexture.dispose();
    if (state.backHingeTexture) state.backHingeTexture.dispose();
    state.frontTexture = null;
    state.spineTexture = null;
    state.backTexture = null;
    state.frontHingeTexture = null;
    state.backHingeTexture = null;
    
    previewImg.src = '';
    previewWrapper.classList.add('hidden');
    dropZone.classList.remove('hidden');
    fileUpload.value = '';

    rebuildBook();
    showToast('↩️ Cover texture cleared. Reverting to blank mock canvas.');
  });

  // Load Demo Cover Button
  loadDemoBtn.addEventListener('click', () => {
    // Prefers the AGI question cover we copied. We also support falling back to WhatsApp cover.
    // Let's load the AGI Question cover by default.
    loadCoverImage('/agi-question.png');
  });

  // Toggle Cover Type (Hardcover vs. Paperback)
  bookTypeRadios.forEach(radio => {
    radio.addEventListener('change', (e) => {
      state.bookType = e.target.value;
      if (state.bookType === 'paperback') {
        state.spineWidth = 0.385; inputSpine.value = 0.385; spineVal.innerText = '0.385"';
      } else {
        state.spineWidth = 0.558; inputSpine.value = 0.558; spineVal.innerText = '0.558"';
      }
      cropCoverWrap(); rebuildBook();
      saveSettings();
      showToast(`⚙️ Switched to ${state.bookType === 'hardcover' ? 'Hardcover' : 'Paperback'}.`);
    });
  });

  // Book dimensions sliders
  inputWidth.addEventListener('input', (e) => { state.width = parseFloat(e.target.value); cropCoverWrap(); rebuildBook(); saveSettings(); });
  inputHeight.addEventListener('input', (e) => { state.height = parseFloat(e.target.value); cropCoverWrap(); rebuildBook(); saveSettings(); });

  inputSpine.addEventListener('input', (e) => {
    state.spineWidth = parseFloat(e.target.value);
    spineVal.innerText = `${state.spineWidth.toFixed(3)}"`;
    const factor = state.bookType === 'paperback' ? 0.0023 : 0.0028;
    state.pages = Math.min(800, Math.max(10, Math.floor(state.spineWidth / factor)));
    inputPages.value = state.pages; pagesVal.innerText = state.pages;
    cropCoverWrap(); rebuildBook(); saveSettings();
  });

  inputPages.addEventListener('input', (e) => {
    state.pages = parseInt(e.target.value);
    pagesVal.innerText = state.pages;
    const factor = state.bookType === 'paperback' ? 0.0023 : 0.0028;
    state.spineWidth = parseFloat((state.pages * factor).toFixed(3));
    inputSpine.value = state.spineWidth; spineVal.innerText = `${state.spineWidth.toFixed(3)}"`;
    cropCoverWrap(); rebuildBook(); saveSettings();
  });

  selectFinish.addEventListener('change', (e) => { state.coverFinish = e.target.value; rebuildBook(); saveSettings(); });
  selectPaper.addEventListener('change', (e) => { state.paperColor = e.target.value; rebuildBook(); saveSettings(); });

  edgeDots.forEach(dot => {
    dot.addEventListener('click', (e) => {
      const style = e.target.getAttribute('data-edge');
      if (style === 'custom') { customEdgeColorInput.click(); return; }
      edgeDots.forEach(d => d.classList.remove('active'));
      e.target.classList.add('active');
      state.pageEdgeStyle = style; rebuildBook(); saveSettings();
    });
  });

  customEdgeColorInput.addEventListener('input', (e) => {
    state.customEdgeColor = e.target.value;
    state.pageEdgeStyle = 'custom';
    edgeDots.forEach(d => d.classList.remove('active'));
    customEdgeTrigger.classList.add('active');
    customEdgeTrigger.style.background = state.customEdgeColor;
    rebuildBook(); saveSettings();
  });

  // Photoshoot presets
  presetCards.forEach(card => {
    card.addEventListener('click', (e) => {
      const cardEl = e.currentTarget;
      presetCards.forEach(c => c.classList.remove('active'));
      cardEl.classList.add('active');
      state.preset = cardEl.getAttribute('data-preset');
      if (state.preset === 'midnight-mood') {
        state.lightIntensity = 0.8; inputIntensity.value = 0.8; intensityVal.innerText = '0.8x'; state.composition = 'standing';
      } else { state.lightIntensity = 1.2; inputIntensity.value = 1.2; intensityVal.innerText = '1.2x'; state.composition = 'standing'; }
      applyPreset(); rebuildBook(); saveSettings();
      showToast(`📸 Preset: ${cardEl.querySelector('.preset-title').innerText}`);
    });
  });

  // Lighting adjusters
  inputIntensity.addEventListener('input', (e) => { state.lightIntensity = parseFloat(e.target.value); intensityVal.innerText = `${state.lightIntensity.toFixed(1)}x`; updateLights(); saveSettings(); });
  inputRotation.addEventListener('input', (e) => { state.lightRotation = parseInt(e.target.value); rotationVal.innerText = `${state.lightRotation}°`; updateLights(); saveSettings(); });

  inputShadow.addEventListener('input', (e) => {
    state.shadowSoftness = parseFloat(e.target.value);
    let text = 'Medium';
    if (state.shadowSoftness < 0.2) text = 'Ultra Sharp';
    else if (state.shadowSoftness < 0.4) text = 'Sharp';
    else if (state.shadowSoftness > 1.0) text = 'Very Soft';
    else if (state.shadowSoftness > 0.7) text = 'Soft';
    shadowVal.innerText = text;
    updateLights(); saveSettings();
  });

  inputFov.addEventListener('input', (e) => {
    state.fov = parseInt(e.target.value);
    let text = `${state.fov}° (Portrait)`;
    if (state.fov < 30) text = `${state.fov}° (Telephoto)`;
    else if (state.fov > 55) text = `${state.fov}° (Wide Angle)`;
    fovVal.innerText = text;
    if (camera) { camera.fov = state.fov; camera.updateProjectionMatrix(); }
    saveSettings();
  });

  // Camera presets
  camButtons.forEach(btn => {
    btn.addEventListener('click', (e) => {
      camButtons.forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');
      
      const pos = e.target.getAttribute('data-cam');
      
      // Calculate distances based on book size
      const maxDim = Math.max(state.width, state.height);

      if (pos === 'front') {
        camera.position.set(0, state.height / 2, maxDim * 1.3);
        controls.target.set(0, state.height / 2, 0);
      } else if (pos === 'spine') {
        camera.position.set(-maxDim * 1.2, state.height / 2, 0);
        controls.target.set(0, state.height / 2, 0);
      } else if (pos === 'back') {
        camera.position.set(0, state.height / 2, -maxDim * 1.3);
        controls.target.set(0, state.height / 2, 0);
      } else if (pos === 'top') {
        camera.position.set(0, maxDim * 1.5, 0.01);
        controls.target.set(0, 0, 0);
      } else { // 3/4 Isometric view
        camera.position.set(state.width * 0.8, state.height * 0.6, state.width * 1.0);
        controls.target.set(0, state.height / 3, 0);
      }
      controls.update();
    });
  });

  resetCamBtn.addEventListener('click', () => {
    camera.position.set(4.5, 3.5, 5.0);
    controls.target.set(0, 0.8, 0);
    controls.update();
    showToast('🎥 Reset camera position.');
  });

  // Grid toggle — shows 60x60 reference grid + world axes (X=red, Y=green, Z=blue)
  toggleGridBtn.addEventListener('click', () => {
    state.showGrid = !state.showGrid;
    if (gridHelper) gridHelper.visible = state.showGrid;
    if (window._axesHelper) window._axesHelper.visible = state.showGrid;
    toggleGridBtn.classList.toggle('active', state.showGrid);
    showToast(state.showGrid
      ? '🟣 Studio Grid ON — each cell = 1 inch. X→red Y↑green Z→blue'
      : '⚫ Studio Grid hidden');
    saveSettings();
  });

  // Export Settings
  selectExportBg.addEventListener('change', (e) => { state.exportBg = e.target.value; saveSettings(); });
  selectExportScale.addEventListener('change', (e) => { state.exportScale = parseInt(e.target.value); saveSettings(); });

  // Image capturing and download export handler
  exportBtn.addEventListener('click', () => {
    spinner.classList.remove('hidden');
    showToast('📸 Rendering studio-quality snapshot...');
  
    // Small delay to let spinner display
    setTimeout(() => {
      try {
        const scale = state.exportScale;
        const currentW = renderer.domElement.width;
        const currentH = renderer.domElement.height;
        
        // Target high-res dims
        const targetW = currentW * scale;
        const targetH = currentH * scale;
  
        // Hide helpers temporarily
        const originalGridVisible = gridHelper.visible;
        gridHelper.visible = false;
  
        // Manage transparency
        let originalBg = scene.background;
        if (state.exportBg === 'transparent') {
          scene.background = null;
          renderer.setClearColor(0x000000, 0);
        }
  
        // Trigger renderer resize to high-res
        renderer.setSize(targetW, targetH, false);
        camera.aspect = targetW / targetH;
        camera.updateProjectionMatrix();
  
        // Render high-res frames
        renderer.render(scene, camera);
  
        // Composite and download the final high-res snapshot
        compositeAndDownload(renderer.domElement, targetW, targetH, () => {
          // Restore renderer settings
          renderer.setSize(currentW, currentH, false);
          camera.aspect = currentW / currentH;
          camera.updateProjectionMatrix();
          gridHelper.visible = originalGridVisible;
          
          if (state.exportBg === 'transparent') {
            scene.background = originalBg;
          }
          
          // Re-render display viewport
          renderer.render(scene, camera);
        });
  
      } catch (err) {
        console.error(err);
        showToast('❌ Failed to capture render.');
        spinner.classList.add('hidden');
      }
    }, 100);
  });
  
  // Composites the WebGL canvas, backdrop photo, and foreground hands overlay into a single image
  function compositeAndDownload(webglCanvas, targetW, targetH, callback) {
    const pre = state.preset;
    const bgUrl = presetBackdrops[pre];
    
    // Create a 2D canvas for compositing
    const compCanvas = document.createElement('canvas');
    compCanvas.width = targetW;
    compCanvas.height = targetH;
    const compCtx = compCanvas.getContext('2d');
    
    const triggerDownload = () => {
      const link = document.createElement('a');
      link.download = `BookStudio3D_Mockup_${state.bookType}_${Date.now()}.png`;
      link.href = compCanvas.toDataURL('image/png');
      link.click();
      showToast('🎉 Snapshot exported successfully!');
      spinner.classList.add('hidden');
      if (callback) callback();
    };
  
    if (bgUrl && state.exportBg !== 'transparent') {
      // Photo backdrop is active and background is NOT transparent
      const bgImg = new Image();
      bgImg.crossOrigin = "anonymous";
      bgImg.onload = () => {
        // Draw background image cropped as cover
        const imgW = bgImg.naturalWidth;
        const imgH = bgImg.naturalHeight;
        const canvasAspect = targetW / targetH;
        const imgAspect = imgW / imgH;
        
        let sWidth, sHeight, sx, sy;
        if (imgAspect > canvasAspect) {
          sWidth = imgH * canvasAspect;
          sHeight = imgH;
          sx = (imgW - sWidth) / 2;
          sy = 0;
        } else {
          sWidth = imgW;
          sHeight = imgW / canvasAspect;
          sx = 0;
          sy = (imgH - sHeight) / 2;
        }
        
        compCtx.drawImage(bgImg, sx, sy, sWidth, sHeight, 0, 0, targetW, targetH);
        
        // Draw WebGL book (including shadow catcher floor/wall) on top
        compCtx.drawImage(webglCanvas, 0, 0);
        
        // Draw foreground fingers cutout on top if active
        const overlayImg = document.getElementById('foreground-overlay');
        if (overlayImg && !overlayImg.classList.contains('hidden') && overlayImg.src) {
          const foreImg = new Image();
          foreImg.crossOrigin = "anonymous";
          foreImg.onload = () => {
            compCtx.drawImage(foreImg, 0, 0, targetW, targetH);
            triggerDownload();
          };
          foreImg.src = overlayImg.src;
        } else {
          triggerDownload();
        }
      };
      bgImg.src = bgUrl;
    } else {
      // Solid color background or transparent background
      if (state.exportBg === 'solid' && (pre === 'studio' || pre === 'midnight-mood')) {
        compCtx.fillStyle = pre === 'midnight-mood' ? '#0a0812' : '#f0f0f5';
        compCtx.fillRect(0, 0, targetW, targetH);
      }
      
      // Draw WebGL book canvas
      compCtx.drawImage(webglCanvas, 0, 0);
      triggerDownload();
    }
  }

  // --- CLICK + DRAG · SCROLL TO SCALE · PINCH TO SCALE ---
  const raycaster = new THREE.Raycaster();
  const mouse = new THREE.Vector2();
  const dragPlane = new THREE.Plane();
  const dragStartPoint = new THREE.Vector3();
  const dragCurrentPoint = new THREE.Vector3();
  const dragStartObjPos = new THREE.Vector3();
  let isDragging = false;
  let dragTarget = null;
  let dragTargetLabel = '';
  let hoveredTarget = null;

  // Collect all raycaster-testable meshes from book + all props
  function getDraggableObjects() {
    const out = [];
    if (bookGroup) bookGroup.traverse(c => { if (c.isMesh) out.push(c); });
    loadedProps.forEach(p => p.group.traverse(c => { if (c.isMesh) out.push(c); }));
    return out;
  }

  // Walk up the parent chain to find which known top-level group owns this mesh
  function findTopGroup(mesh) {
    if (!mesh) return null;
    const known = [];
    if (bookGroup) known.push({ group: bookGroup, name: 'Book' });
    loadedProps.forEach(p => known.push(p));
    let cur = mesh;
    while (cur && cur !== scene) {
      for (const k of known) { if (cur === k.group) return k; }
      cur = cur.parent;
    }
    return null;
  }

  // POINTER DOWN — start drag
  canvas.addEventListener('pointerdown', (e) => {
    if (state.preset === 'hands-blue' || state.preset === 'hands-sky') return;
    if (e.button !== 0) return;
    const rect = renderer.domElement.getBoundingClientRect();
    mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);
    const hits = raycaster.intersectObjects(getDraggableObjects(), false);
    if (hits.length > 0) {
      const found = findTopGroup(hits[0].object);
      if (found) {
        dragTarget = found.group;
        dragTargetLabel = found.name;
        dragPlane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0,1,0), dragTarget.position);
        if (raycaster.ray.intersectPlane(dragPlane, dragStartPoint)) {
          dragStartObjPos.copy(dragTarget.position);
          isDragging = true;
          controls.enabled = false;
          canvas.setPointerCapture(e.pointerId);
          canvas.style.cursor = 'grabbing';
          showToast(`🎯 Drag to move · Scroll/Pinch to scale`);
          // Auto-select in outliner
          if (window.__onDragStart) window.__onDragStart(found.name);
        }
      }
    } else {
      // Clicked empty space — deselect
      if (window.__selectSceneObj) window.__selectSceneObj(null);
    }
  });

  // POINTER MOVE — drag object OR update hover
  canvas.addEventListener('pointermove', (e) => {
    const rect = renderer.domElement.getBoundingClientRect();
    mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);

    if (isDragging && dragTarget) {
      if (raycaster.ray.intersectPlane(dragPlane, dragCurrentPoint)) {
        const delta = new THREE.Vector3().subVectors(dragCurrentPoint, dragStartPoint);
        const np = dragStartObjPos.clone().add(delta);
        np.y = dragStartObjPos.y;
        dragTarget.position.copy(np);
      }
    } else {
      if (state.preset === 'hands-blue' || state.preset === 'hands-sky') return;
      const hits = raycaster.intersectObjects(getDraggableObjects(), false);
      if (hits.length > 0) {
        hoveredTarget = findTopGroup(hits[0].object);
        canvas.style.cursor = hoveredTarget ? 'grab' : 'default';
      } else {
        hoveredTarget = null;
        canvas.style.cursor = 'default';
      }
    }
  });

  // POINTER UP — release drag — save final position to localStorage
  canvas.addEventListener('pointerup', (e) => {
    if (isDragging) {
      isDragging = false;
      controls.enabled = !(state.preset === 'hands-blue' || state.preset === 'hands-sky');
      canvas.releasePointerCapture(e.pointerId);
      canvas.style.cursor = hoveredTarget ? 'grab' : 'default';
      showToast(`📍 ${dragTargetLabel} placed · Scroll wheel to scale`);
      dragTarget = null;
      saveSettings(); // persist new position
    }
  });

  // SCROLL WHEEL — scale hovered or active drag target, then save
  canvas.addEventListener('wheel', (e) => {
    const target = (dragTarget ? { group: dragTarget, name: dragTargetLabel } : hoveredTarget);
    if (!target) return;
    e.preventDefault();
    const dir = e.deltaY < 0 ? 1 : -1;
    const factor = 1 + dir * 0.06;
    const cur = target.group.scale.x;
    const next = Math.max(0.05, Math.min(10.0, cur * factor));
    target.group.scale.setScalar(next);
    showToast(`📐 ${target.name}: ${next.toFixed(2)}×`);
    saveSettings(); // persist new scale
  }, { passive: false });

  // PINCH GESTURE — scale on touch screens
  let pinchDist0 = 0;
  let pinchScale0 = 1;
  let pinchObj = null;
  canvas.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      pinchDist0 = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      pinchObj = dragTarget ? { group: dragTarget, name: dragTargetLabel } : hoveredTarget;
      if (pinchObj) pinchScale0 = pinchObj.group.scale.x;
    }
  }, { passive: true });
  canvas.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2 && pinchObj) {
      e.preventDefault();
      const d = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      const next = Math.max(0.05, Math.min(10.0, pinchScale0 * (d / pinchDist0)));
      pinchObj.group.scale.setScalar(next);
    }
  }, { passive: false });
  canvas.addEventListener('touchend', () => { pinchObj = null; });

  // Toast notifier
  function showToast(msg) {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.innerText = msg;
    toast.classList.add('show');
    if (toast.timeoutId) clearTimeout(toast.timeoutId);
    toast.timeoutId = setTimeout(() => { toast.classList.remove('show'); }, 3500);
  }
});
