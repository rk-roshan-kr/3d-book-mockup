import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

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
  
  // Book alignment nudges
  bookNudgeX: 0.0,
  bookNudgeY: 0.0,
  bookNudgeZ: 0.0,
  bookNudgeRy: 0.0,
  bookNudgeScale: 1.0,
  
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
          exportBg: state.exportBg, exportScale: state.exportScale,
          coverImageSrc: state.coverImageSrc
        },
        objects: {}
      };
      // Save book group transform
      if (bookGroup) {
        data.objects.book = {
          px: bookGroup.position.x, py: bookGroup.position.y, pz: bookGroup.position.z,
          rx: bookGroup.rotation.x, ry: bookGroup.rotation.y, rz: bookGroup.rotation.z,
          s: bookGroup.scale.x, visible: bookGroup.visible,
          locked: !!bookGroup.userData.locked
        };
      }
      // Save prop transforms
      loadedProps.forEach(p => {
        data.objects[p.name.toLowerCase()] = {
          px: p.group.position.x, py: p.group.position.y, pz: p.group.position.z,
          rx: p.group.rotation.x, ry: p.group.rotation.y, rz: p.group.rotation.z,
          s: p.group.scale.x, visible: p.group.visible,
          locked: !!p.group.userData.locked
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
    bookGroup.userData.locked = !!o.book.locked;
  }
  loadedProps.forEach(p => {
    const key = p.name.toLowerCase();
    if (o[key]) {
      p.group.position.set(o[key].px, o[key].py, o[key].pz);
      p.group.rotation.set(o[key].rx, o[key].ry, o[key].rz);
      p.group.scale.setScalar(o[key].s ?? 1);
      p.group.visible = o[key].visible !== false;
      p.group.userData.locked = !!o[key].locked;
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
let backWallPlane; // back wall of the room
let wallShadowPlane; // vertical wall shadow catcher plane
let propsGroup;      // 3D scene props group (mug, plant, pen)
let loadedProps = []; // list of { group, name } for click-drag interaction
let handsGroup;       // Group containing interactive 3D hand meshes
let leftHandModel = null, rightHandModel = null;

// Procedural textures
let linenBumpTexture, paperBumpTexture, pageEdgeTextureMap = {};
let concretePhotoTexture = null;

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

// Draw a leaf outline + window frame grid to use as branch and window shadow stencil
function generateLeafStencilCanvas() {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 1024;
  const ctx = canvas.getContext('2d');
  
  // Transparent background (where light passes through)
  ctx.clearRect(0, 0, 1024, 1024);
  
  // Fill the canvas with solid black (blocked light / shadow areas)
  ctx.fillStyle = '#000000';
  
  // 1. Draw Window Frame Shadow:
  // We draw vertical frame columns and a horizontal crossbar.
  // The light's diagonal angle will cast these as beautiful slanted window panes.
  ctx.fillRect(0, 0, 120, 1024);       // Left frame boundary
  ctx.fillRect(420, 0, 100, 1024);     // Middle frame column
  ctx.fillRect(820, 0, 120, 1024);     // Right frame column
  
  // Horizontal transom/crossbar
  ctx.fillRect(0, 360, 1024, 90);
  
  // 2. Draw organic leaf branches overlaying the window openings:
  ctx.save();
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 14;
  ctx.beginPath();
  ctx.moveTo(150, 200);
  ctx.bezierCurveTo(300, 220, 600, 50, 900, 250);
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
  
  // Add leaves along the branch
  drawLeaf(300, 195, -Math.PI / 4, 110, 42);
  drawLeaf(380, 175, Math.PI / 5, 100, 38);
  drawLeaf(480, 140, -Math.PI / 6, 120, 45);
  drawLeaf(580, 110, Math.PI / 4, 110, 40);
  drawLeaf(680, 105, -Math.PI / 5, 130, 48);
  drawLeaf(760, 130, Math.PI / 6, 95, 36);
  
  // Add another smaller secondary branch
  ctx.lineWidth = 8;
  ctx.beginPath();
  ctx.moveTo(500, 550);
  ctx.bezierCurveTo(600, 580, 800, 500, 1024, 600);
  ctx.stroke();
  
  drawLeaf(620, 570, Math.PI / 4, 80, 30);
  drawLeaf(720, 560, -Math.PI / 5, 90, 34);
  drawLeaf(820, 530, Math.PI / 6, 85, 32);
  drawLeaf(920, 545, -Math.PI / 4, 70, 26);
  
  ctx.restore();
  
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

// Procedural light wood desk texture (Birch/Pine)
function generateLightWoodTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 1024;
  const ctx = canvas.getContext('2d');
  
  // Base light birch wood color
  ctx.fillStyle = '#e8d8c8';
  ctx.fillRect(0, 0, 1024, 1024);
  
  // Draw wood planks
  const plankWidth = 204.8; // 5 planks
  ctx.fillStyle = 'rgba(0, 0, 0, 0.04)';
  for (let i = 0; i < 5; i++) {
    ctx.fillRect(i * plankWidth, 0, 1.5, 1024);
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
    ctx.strokeStyle = 'rgba(100, 70, 40, 0.06)';
    ctx.lineWidth = 1.2;
    
    const waveCount = 20 + Math.random() * 12;
    for (let w = 0; w < waveCount; w++) {
      const xOffset = startX + (w / waveCount) * plankWidth + (Math.random() - 0.5) * 12;
      
      ctx.beginPath();
      ctx.moveTo(xOffset, 0);
      let currentX = xOffset;
      let currentY = 0;
      while (currentY < 1024) {
        const nextY = currentY + 50 + Math.random() * 50;
        const offset = Math.sin(currentY * 0.012 + plank) * 6 + (Math.random() - 0.5) * 1.5;
        ctx.lineTo(xOffset + offset, nextY);
        currentY = nextY;
      }
      ctx.stroke();
    }
    
    // Draw subtle wood knots
    if (Math.random() > 0.6) {
      const knotY = 200 + Math.random() * 600;
      const knotX = startX + plankWidth / 2 + (Math.random() - 0.5) * 30;
      
      ctx.fillStyle = 'rgba(100, 70, 40, 0.1)';
      ctx.beginPath();
      ctx.arc(knotX, knotY, 10 + Math.random() * 10, 0, Math.PI * 2);
      ctx.fill();
      
      // Ring swirls
      ctx.strokeStyle = 'rgba(100, 70, 40, 0.08)';
      for (let r = 1; r < 4; r++) {
        ctx.beginPath();
        ctx.arc(knotX, knotY, r * 15 + Math.random() * 4, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    
    ctx.restore();
  }
  
  // Warm soft overlay gradient
  const grad = ctx.createLinearGradient(0, 0, 1024, 1024);
  grad.addColorStop(0, 'rgba(255, 255, 255, 0.15)');
  grad.addColorStop(1, 'rgba(80, 50, 20, 0.08)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 1024, 1024);

  const tex = new THREE.CanvasTexture(canvas);
  return tex;
}

// Procedural concrete texture generator
function generateConcreteTexture(baseColorHex = '#b8b2ac', roughness = 0.6) {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 1024;
  const ctx = canvas.getContext('2d');
  
  // Parse base color to RGB
  const shorthandRegex = /^#?([a-f\d])([a-f\d])([a-f\d])$/i;
  const fullHex = baseColorHex.replace(shorthandRegex, (m, r, g, b) => r + r + g + g + b + b);
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(fullHex);
  const baseRGB = result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : { r: 184, g: 178, b: 172 };

  // 1. Fast direct pixel buffer noise generation
  const imgData = ctx.createImageData(1024, 1024);
  const data = imgData.data;
  for (let i = 0; i < data.length; i += 4) {
    const noise = (Math.random() - 0.5) * 16;
    data[i]     = Math.min(255, Math.max(0, baseRGB.r + noise));     // R
    data[i + 1] = Math.min(255, Math.max(0, baseRGB.g + noise));     // G
    data[i + 2] = Math.min(255, Math.max(0, baseRGB.b + noise));     // B
    data[i + 3] = 255;                                               // A
  }
  ctx.putImageData(imgData, 0, 0);
  
  // 2. Cloudy concrete plaster stains (large organic variations)
  for (let i = 0; i < 20; i++) {
    const x = Math.random() * 1024;
    const y = Math.random() * 1024;
    const rad = 150 + Math.random() * 200;
    
    const grad = ctx.createRadialGradient(x, y, 0, x, y, rad);
    const isDark = Math.random() > 0.5;
    const opacity = 0.04 + Math.random() * 0.05;
    
    if (isDark) {
      grad.addColorStop(0, `rgba(40, 35, 30, ${opacity})`);
    } else {
      grad.addColorStop(0, `rgba(255, 250, 240, ${opacity})`);
    }
    grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, rad, 0, Math.PI * 2);
    ctx.fill();
  }
  
  // 3. Micro-scratches & concrete pores
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.07)';
  ctx.lineWidth = 1.0;
  for (let i = 0; i < 40; i++) {
    const x = Math.random() * 1024;
    const y = Math.random() * 1024;
    const len = 5 + Math.random() * 15;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + (Math.random() - 0.5) * len, y + (Math.random() - 0.5) * len);
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1.5, 1.5);
  tex.needsUpdate = true;
  return tex;
}

// Loads a high-res concrete texture patch from a real photo backdrop
function loadConcretePhotoTexture() {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    // Create an offscreen canvas to crop a clean patch of concrete texture
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 1024;
    const ctx = canvas.getContext('2d');
    
    // Crop a clean, high-texture 500x500 patch from the top-left area (wall region)
    // and tile/stretch it onto the 1024x1024 texture canvas
    ctx.drawImage(img, 100, 100, 500, 500, 0, 0, 1024, 1024);
    
    // Overlay pixel-level micro-roughness noise to add physical depth/grain
    const imgData = ctx.getImageData(0, 0, 1024, 1024);
    const data = imgData.data;
    for (let i = 0; i < data.length; i += 4) {
      const noise = (Math.random() - 0.5) * 8;
      data[i]     = Math.min(255, Math.max(0, data[i] + noise));
      data[i + 1] = Math.min(255, Math.max(0, data[i + 1] + noise));
      data[i + 2] = Math.min(255, Math.max(0, data[i + 2] + noise));
    }
    ctx.putImageData(imgData, 0, 0);

    concretePhotoTexture = new THREE.CanvasTexture(canvas);
    concretePhotoTexture.colorSpace = THREE.SRGBColorSpace;
    concretePhotoTexture.wrapS = THREE.RepeatWrapping;
    concretePhotoTexture.wrapT = THREE.RepeatWrapping;
    concretePhotoTexture.repeat.set(1.8, 1.8);
    concretePhotoTexture.needsUpdate = true;
    
    // Re-apply preset if concrete-leaning-3d is active to refresh textures
    if (state.preset === 'concrete-leaning-3d' || state.preset === 'creative-studio') {
      applyPreset();
    }
  };
  img.onerror = (err) => {
    console.error('Failed to load concrete photo backdrop for texture map', err);
  };
  img.src = 'backdrop_concrete_wall.png';
}

// Asynchronously loads and sets up rigged left and right 3D hand models
function loadHandModels() {
  const loader = new GLTFLoader();
  const skinMaterial = new THREE.MeshStandardMaterial({
    color: 0xeadbc8, // realistic warm light skin tone
    roughness: 0.65,
    metalness: 0.0
  });

  loader.load('left_hand.glb', (gltf) => {
    leftHandModel = gltf.scene;
    leftHandModel.traverse(child => {
      if (child.isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;
        child.material = skinMaterial;
      }
    });
    console.log('3D Left Hand model loaded successfully.');
    if (state.preset === 'hands-cotton') {
      applyPreset();
      rebuildBook();
    }
  }, undefined, (err) => {
    console.warn('left_hand.glb failed to load:', err);
  });

  loader.load('right_hand.glb', (gltf) => {
    rightHandModel = gltf.scene;
    rightHandModel.traverse(child => {
      if (child.isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;
        child.material = skinMaterial;
      }
    });
    console.log('3D Right Hand model loaded successfully.');
    if (state.preset === 'hands-cotton') {
      applyPreset();
      rebuildBook();
    }
  }, undefined, (err) => {
    console.warn('right_hand.glb failed to load:', err);
  });
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


// Setup and load 3D props (cup, plant, camera, glasses, bottle, avocado, pen)
function create3DProps() {
  if (!propsGroup) return;

  loadedProps = [];
  const loader = new GLTFLoader();

  // -- 1. Load real Khronos GLB Plant model --
  const plantGroup = new THREE.Group();
  plantGroup.position.set(-4.0, 0, -2.8);
  plantGroup.scale.set(1.0, 1.0, 1.0);
  propsGroup.add(plantGroup);
  loadedProps.push({ group: plantGroup, name: 'Plant' });

  loader.load('plant.glb', (gltf) => {
    const model = gltf.scene;
    model.traverse(child => {
      if (child.isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
    fitModelToMaxDimension(model, 8.0); // Target exactly 8.0 inches longest dimension
    // Center model at base
    const box = new THREE.Box3().setFromObject(model);
    const center = box.getCenter(new THREE.Vector3());
    model.position.set(-center.x, -box.min.y, -center.z);
    plantGroup.add(model);
  }, undefined, (err) => {
    console.warn('plant.glb failed, using fallback', err);
    showToast(`⚠️ Plant GLB failed to parse/load: ${err?.message || err?.type || 'Format/Network error'}`);
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
  cupGroup.scale.set(1.0, 1.0, 1.0);
  propsGroup.add(cupGroup);
  loadedProps.push({ group: cupGroup, name: 'Teacup' });

  loader.load('teacup.glb', (gltf) => {
    const model = gltf.scene;
    model.traverse(child => {
      if (child.isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
    fitModelToMaxDimension(model, 3.6); // Target exactly 3.6 inches longest dimension
    // Center model at base
    const box = new THREE.Box3().setFromObject(model);
    const center = box.getCenter(new THREE.Vector3());
    model.position.set(-center.x, -box.min.y, -center.z);
    cupGroup.add(model);
  }, undefined, (err) => {
    console.warn('teacup.glb failed, using fallback', err);
    showToast(`⚠️ Teacup GLB failed to parse/load: ${err?.message || err?.type || 'Format/Network error'}`);
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

  // -- 3. Load Glasses model --
  const glassesGroup = new THREE.Group();
  glassesGroup.position.set(2.5, 0.05, 1.8);
  glassesGroup.rotation.set(0, -0.4, 0);
  glassesGroup.scale.set(1.0, 1.0, 1.0);
  propsGroup.add(glassesGroup);
  loadedProps.push({ group: glassesGroup, name: 'Glasses' });

  loader.load('glasses.glb', (gltf) => {
    const model = gltf.scene;
    model.traverse(child => {
      if (child.isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
    fitModelToMaxDimension(model, 5.5); // Target exactly 5.5 inches width
    // Center model at base
    const box = new THREE.Box3().setFromObject(model);
    const center = box.getCenter(new THREE.Vector3());
    model.position.set(-center.x, -box.min.y, -center.z);
    glassesGroup.add(model);
  }, undefined, (err) => {
    console.warn('glasses.glb failed, using fallback', err);
    showToast(`⚠️ Glasses GLB failed to parse/load: ${err?.message || err?.type || 'Format/Network error'}`);
    // Fallback eyeglasses
    const glassMat = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.2, metalness: 0.8 });
    const lensMat = new THREE.MeshPhysicalMaterial({ color: 0xffffff, transparent: true, opacity: 0.3, roughness: 0.1 });
    // Left eye ring
    const leftRing = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.03, 8, 24), glassMat);
    leftRing.position.set(-0.25, 0.2, 0);
    glassesGroup.add(leftRing);
    const leftLens = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.02, 16), lensMat);
    leftLens.rotation.x = Math.PI / 2;
    leftLens.position.set(-0.25, 0.2, 0);
    glassesGroup.add(leftLens);
    // Right eye ring
    const rightRing = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.03, 8, 24), glassMat);
    rightRing.position.set(0.25, 0.2, 0);
    glassesGroup.add(rightRing);
    const rightLens = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.02, 16), lensMat);
    rightLens.rotation.x = Math.PI / 2;
    rightLens.position.set(0.25, 0.2, 0);
    glassesGroup.add(rightLens);
    // Bridge
    const bridge = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.14), glassMat);
    bridge.rotation.z = Math.PI / 2;
    bridge.position.set(0, 0.22, 0);
    glassesGroup.add(bridge);
  });

  // -- 4. Load Antique Camera model --
  const cameraGroup = new THREE.Group();
  cameraGroup.position.set(-3.5, 0, 2.5);
  cameraGroup.rotation.set(0, 0.6, 0);
  cameraGroup.scale.set(1.0, 1.0, 1.0);
  propsGroup.add(cameraGroup);
  loadedProps.push({ group: cameraGroup, name: 'Camera' });

  loader.load('antique_camera.glb', (gltf) => {
    const model = gltf.scene;
    model.traverse(child => {
      if (child.isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
    fitModelToMaxDimension(model, 5.2); // Target exactly 5.2 inches width
    // Center model at base
    const box = new THREE.Box3().setFromObject(model);
    const center = box.getCenter(new THREE.Vector3());
    model.position.set(-center.x, -box.min.y, -center.z);
    cameraGroup.add(model);
  }, undefined, (err) => {
    console.warn('antique_camera.glb failed, using fallback', err);
    showToast(`⚠️ Camera GLB failed to parse/load: ${err?.message || err?.type || 'Format/Network error'}`);
    // Fallback camera
    const camBodyMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.7 });
    const camLensMat = new THREE.MeshStandardMaterial({ color: 0x111111, metalness: 0.9, roughness: 0.1 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.5, 0.4), camBodyMat);
    body.position.y = 0.25;
    body.castShadow = true;
    cameraGroup.add(body);
    const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.3, 24), camLensMat);
    lens.rotation.x = Math.PI / 2;
    lens.position.set(0, 0.25, 0.25);
    lens.castShadow = true;
    cameraGroup.add(lens);
  });

  // -- 5. Load Water Bottle model --
  const bottleGroup = new THREE.Group();
  bottleGroup.position.set(4.5, 0, 1.2);
  bottleGroup.scale.set(1.0, 1.0, 1.0);
  propsGroup.add(bottleGroup);
  loadedProps.push({ group: bottleGroup, name: 'Bottle' });

  loader.load('water_bottle.glb', (gltf) => {
    const model = gltf.scene;
    model.traverse(child => {
      if (child.isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
    fitModelToMaxDimension(model, 8.5); // Target exactly 8.5 inches height
    // Center model at base
    const box = new THREE.Box3().setFromObject(model);
    const center = box.getCenter(new THREE.Vector3());
    model.position.set(-center.x, -box.min.y, -center.z);
    bottleGroup.add(model);
  }, undefined, (err) => {
    console.warn('water_bottle.glb failed, using fallback', err);
    showToast(`⚠️ Water Bottle GLB failed to parse/load: ${err?.message || err?.type || 'Format/Network error'}`);
    // Fallback sports bottle
    const botMat = new THREE.MeshPhysicalMaterial({ color: 0x0284c7, roughness: 0.2, metalness: 0.1, clearcoat: 1.0 });
    const capMat = new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.5 });
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 0.9, 24), botMat);
    body.position.y = 0.45;
    body.castShadow = true;
    bottleGroup.add(body);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.15, 24), capMat);
    cap.position.y = 0.955;
    cap.castShadow = true;
    bottleGroup.add(cap);
  });

  // -- 6. Load Avocado model --
  const avocadoGroup = new THREE.Group();
  avocadoGroup.position.set(-2.0, 0, 3.5);
  avocadoGroup.rotation.set(0.2, 0.8, -0.1);
  avocadoGroup.scale.set(1.0, 1.0, 1.0);
  propsGroup.add(avocadoGroup);
  loadedProps.push({ group: avocadoGroup, name: 'Avocado' });

  loader.load('avocado.glb', (gltf) => {
    const model = gltf.scene;
    model.traverse(child => {
      if (child.isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
    fitModelToMaxDimension(model, 4.0); // Target exactly 4.0 inches length
    // Center model at base
    const box = new THREE.Box3().setFromObject(model);
    const center = box.getCenter(new THREE.Vector3());
    model.position.set(-center.x, -box.min.y, -center.z);
    avocadoGroup.add(model);
  }, undefined, (err) => {
    console.warn('avocado.glb failed, using fallback', err);
    showToast(`⚠️ Avocado GLB failed to parse/load: ${err?.message || err?.type || 'Format/Network error'}`);
    // Fallback avocado sphere
    const avoMat = new THREE.MeshStandardMaterial({ color: 0x1e3a1e, roughness: 0.9 });
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.2, 16, 16), avoMat);
    body.scale.set(1, 1.4, 1);
    body.position.y = 0.2;
    body.castShadow = true;
    avocadoGroup.add(body);
  });

  // -- 7. Brass Pen (lengthened to standard 5.8 inches) --
  const penGroup = new THREE.Group();
  const penGeom = new THREE.CylinderGeometry(0.06, 0.05, 5.5, 12);
  const penMat = new THREE.MeshStandardMaterial({ color: 0xca8a04, metalness: 0.92, roughness: 0.15 });
  const penMesh = new THREE.Mesh(penGeom, penMat);
  penMesh.rotation.x = Math.PI / 2;
  penMesh.rotation.y = 0.4;
  penMesh.castShadow = true;
  penGroup.add(penMesh);
  // Pen tip
  const tipMesh = new THREE.Mesh(
    new THREE.ConeGeometry(0.05, 0.3, 12),
    new THREE.MeshStandardMaterial({ color: 0x1a1a1a, metalness: 0.8, roughness: 0.2 })
  );
  tipMesh.position.z = -2.875;
  tipMesh.rotation.x = -Math.PI / 2;
  penGroup.add(tipMesh);
  penGroup.position.set(1.8, 0.06, 3.2);
  propsGroup.add(penGroup);
  loadedProps.push({ group: penGroup, name: 'Pen' });

  // -- 8. Load Scale model --
  const scaleGroup = new THREE.Group();
  scaleGroup.position.set(-5.0, 0, 1.0);
  scaleGroup.scale.set(1.0, 1.0, 1.0);
  propsGroup.add(scaleGroup);
  loadedProps.push({ group: scaleGroup, name: 'Scale' });

  loader.load('arunangshubanerjee-scale-1599.glb', (gltf) => {
    const model = gltf.scene;
    model.traverse(child => {
      if (child.isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
    fitModelToMaxDimension(model, 7.0); // Target 7.0 inches
    const box = new THREE.Box3().setFromObject(model);
    const center = box.getCenter(new THREE.Vector3());
    model.position.set(-center.x, -box.min.y, -center.z);
    scaleGroup.add(model);
  }, undefined, (err) => {
    console.warn('scale glb failed, using fallback', err);
    showToast(`⚠️ Scale GLB failed to parse/load: ${err?.message || err?.type || 'Format/Network error'}`);
    // Fallback scale
    const brassMat = new THREE.MeshStandardMaterial({ color: 0xca8a04, metalness: 0.9, roughness: 0.2 });
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 2.0), brassMat);
    post.position.y = 1.0;
    post.castShadow = true;
    scaleGroup.add(post);
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.8), brassMat);
    beam.rotation.z = Math.PI / 2;
    beam.position.y = 1.9;
    beam.castShadow = true;
    scaleGroup.add(beam);
  });

  // -- 9. Load Armchair model --
  const armchairGroup = new THREE.Group();
  armchairGroup.position.set(-8.0, 0, -7.0);
  armchairGroup.rotation.set(0, 0.5, 0);
  armchairGroup.scale.set(1.0, 1.0, 1.0);
  propsGroup.add(armchairGroup);
  loadedProps.push({ group: armchairGroup, name: 'Armchair' });

  loader.load('denielcz-armchair-2924.glb', (gltf) => {
    const model = gltf.scene;
    model.traverse(child => {
      if (child.isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
    fitModelToMaxDimension(model, 36.0); // Large armchair!
    const box = new THREE.Box3().setFromObject(model);
    const center = box.getCenter(new THREE.Vector3());
    model.position.set(-center.x, -box.min.y, -center.z);
    armchairGroup.add(model);
  }, undefined, (err) => {
    console.warn('armchair glb failed, using fallback', err);
    showToast(`⚠️ Armchair GLB failed to parse/load: ${err?.message || err?.type || 'Format/Network error'}`);
    // Fallback armchair
    const fabricMat = new THREE.MeshStandardMaterial({ color: 0x3b82f6, roughness: 0.9 });
    const seat = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.8, 2.5), fabricMat);
    seat.position.y = 0.8;
    seat.castShadow = true;
    armchairGroup.add(seat);
    const back = new THREE.Mesh(new THREE.BoxGeometry(2.5, 2.0, 0.6), fabricMat);
    back.position.set(0, 1.8, -1.0);
    back.castShadow = true;
    armchairGroup.add(back);
  });

  // -- 10. Load Lantern model --
  const lanternGroup = new THREE.Group();
  lanternGroup.position.set(5.5, 0, 1.5);
  lanternGroup.scale.set(1.0, 1.0, 1.0);
  propsGroup.add(lanternGroup);
  loadedProps.push({ group: lanternGroup, name: 'Lantern' });

  loader.load('pixellabs-lantern-3333.glb', (gltf) => {
    const model = gltf.scene;
    model.traverse(child => {
      if (child.isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
    fitModelToMaxDimension(model, 10.0); // 10 inches tall
    const box = new THREE.Box3().setFromObject(model);
    const center = box.getCenter(new THREE.Vector3());
    model.position.set(-center.x, -box.min.y, -center.z);
    lanternGroup.add(model);
  }, undefined, (err) => {
    console.warn('lantern glb failed, using fallback', err);
    showToast(`⚠️ Lantern GLB failed to parse/load: ${err?.message || err?.type || 'Format/Network error'}`);
    // Fallback lantern
    const metalMat = new THREE.MeshStandardMaterial({ color: 0x475569, metalness: 0.8, roughness: 0.3 });
    const glassMat = new THREE.MeshPhysicalMaterial({ color: 0xffffff, transparent: true, opacity: 0.4, roughness: 0.1 });
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.2, 16), metalMat);
    base.position.y = 0.1;
    base.castShadow = true;
    lanternGroup.add(base);
    const chamber = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.5, 16), glassMat);
    chamber.position.y = 0.45;
    chamber.castShadow = true;
    lanternGroup.add(chamber);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.26, 0.15, 16), metalMat);
    cap.position.y = 0.775;
    cap.castShadow = true;
    lanternGroup.add(cap);
  });

  // Hide by default (shown only in wood-angle 3D scene)
  propsGroup.visible = false;
}

// --- 3D BOOK GEOMETRY GENERATORS ---

// Clear existing book mesh group and re-create it based on settings
function rebuildBook() {
  if (!scene) return;
  
  let oldUserData = {};
  let oldPos, oldRot, oldScale;
  let oldVisible = true;
  
  // Remove old group
  if (bookGroup) {
    oldUserData = Object.assign({}, bookGroup.userData);
    oldPos = bookGroup.position.clone();
    oldRot = bookGroup.rotation.clone();
    oldScale = bookGroup.scale.clone();
    oldVisible = bookGroup.visible;

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
  bookGroup.userData = oldUserData;
  bookGroup.visible = oldVisible;
  bookGroup.castShadow = true;
  bookGroup.receiveShadow = true;

  // Render book based on layout type
  if (state.bookType === 'hardcover') {
    createHardcoverMesh();
  } else {
    createPaperbackMesh();
  }

  if (oldPos) {
    bookGroup.position.copy(oldPos);
    bookGroup.rotation.copy(oldRot);
    bookGroup.scale.copy(oldScale);
  } else {
    // Adjust book position based on composition preset
    applyComposition();
  }

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
    
    // 3. Hand-held paperback cylindrical curve / bend
    let curveAmount = 0.0;
    if (state.preset === 'hands-cotton') {
      curveAmount = 0.40; // Significant flex for Cotton Cover (Hand)
    } else if (state.preset === 'hands-blue') {
      curveAmount = 0.16; // Medium flex
    } else if (state.preset === 'hands-sky') {
      curveAmount = 0.06; // Gentle flex
    }
    
    if (curveAmount > 0.001) {
      const normX = v.x / (w / 2); // -1.0 to 1.0
      const bend = curveAmount * Math.pow(normX, 2);
      v.z += bend;
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

const presetBackdrops = {
  'clean-flatlay': '/backdrop_clean_flatlay.png',
  'concrete-wall': '/backdrop_concrete_wall.png',
  'hands-blue': '/backdrop_hands_blue.png',
  'hands-sky': '/backdrop_hands_sky.png'
};

// Automatically positions book and camera to match backdrop photography angles
// Frame the camera dynamically on the book using responsive bounding box projection
function frameCameraOnBook(pre) {
  if (!camera || !controls || !bookGroup) return;

  const box = new THREE.Box3().setFromObject(bookGroup);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  const fovRad = (camera.fov * Math.PI) / 180;
  
  let dist = (maxDim / 2) / Math.tan(fovRad / 2);
  
  let targetPos = new THREE.Vector3();
  let targetCtr = center.clone();
  
  if (pre === 'hands-blue') {
    targetPos.set(0.0, 1.8, 13.5);
    targetCtr.set(-0.2, 1.3, 0);
  } else if (pre === 'hands-sky') {
    targetPos.set(0.0, 2.2, 13.0);
    targetCtr.set(0, 1.6, 0);
  } else {
    let dir = new THREE.Vector3();
    let zoomMultiplier = 1.35;
    
    if (pre === 'clean-flatlay') {
      dir.set(0.3, 0.9, 0.3).normalize();
      zoomMultiplier = 1.4;
    } else if (pre === 'concrete-wall' || pre === 'concrete-leaning-3d') {
      dir.set(0.5, 0.25, 0.83).normalize();
      zoomMultiplier = 1.35;
    } else if (pre === 'wood-angle') {
      dir.set(0.42, 0.62, 0.66).normalize();
      zoomMultiplier = 1.3;
    } else if (pre === 'marble-desk') {
      dir.set(-0.45, 0.55, 0.70).normalize();
      zoomMultiplier = 1.3;
    } else if (pre === 'creative-studio') {
      dir.set(0.5, 0.35, 0.78).normalize();
      zoomMultiplier = 1.35;
    } else if (pre === 'modern-study') {
      dir.set(0.53, 0.42, 0.73).normalize();
      zoomMultiplier = 1.35;
    } else { // studio or midnight-mood
      dir.set(0.55, 0.4, 0.73).normalize();
      zoomMultiplier = 1.3;
    }
    
    targetPos.copy(targetCtr).addScaledVector(dir, dist * zoomMultiplier);
  }
  
  camera.position.copy(targetPos);
  controls.target.copy(targetCtr);
  controls.update();
}

// Positions the 3D hand models to grip the book edges in real-time
function update3DHands() {
  if (!handsGroup) return;

  const pre = state.preset;
  if (pre !== 'hands-cotton') {
    handsGroup.visible = false;
    return;
  }

  handsGroup.visible = true;
  handsGroup.clear();

  // Position handsGroup to match the bookGroup transforms exactly
  if (bookGroup) {
    handsGroup.position.copy(bookGroup.position);
    handsGroup.rotation.copy(bookGroup.rotation);
    handsGroup.scale.copy(bookGroup.scale);
  }

  const w = state.width * INCH_TO_THREE;
  const h = state.height * INCH_TO_THREE;
  const d = state.spineWidth * INCH_TO_THREE;
  const bt = state.boardThickness * INCH_TO_THREE;
  const thickness = state.bookType === 'hardcover' ? (d + 2 * bt) : d;

  // Let's place the left hand model (holding the spine / back cover)
  if (leftHandModel) {
    // left hand positioned on left edge
    leftHandModel.position.set(-w / 2 - 0.6, h / 2 - 3.2, 0.6);
    // rotate it to look like it's grasping the cover
    leftHandModel.rotation.set(Math.PI / 2.2, Math.PI / 4, -Math.PI / 12);
    leftHandModel.scale.setScalar(26.0);
    handsGroup.add(leftHandModel);
  }

  // Let's place the right hand model (holding the front cover / page edges)
  if (rightHandModel) {
    // right hand positioned on right edge
    rightHandModel.position.set(w / 2 + 0.6, h / 2 - 3.2, 0.6);
    // rotate it to grasp the page edge
    rightHandModel.rotation.set(Math.PI / 2.2, -Math.PI / 4, Math.PI / 12);
    rightHandModel.scale.setScalar(26.0);
    handsGroup.add(rightHandModel);
  }
}

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
    bookGroup.rotation.x = -Math.PI / 2;
    bookGroup.rotation.z = Math.PI / 6;
    bookGroup.position.set(-0.3, thickness / 2, 0.2);

  } else if (pre === 'concrete-wall' || pre === 'concrete-leaning-3d') {
    state.composition = 'standing';
    bookGroup.rotation.x = -0.15;
    bookGroup.rotation.y = -0.3;
    bookGroup.rotation.z = 0;
    bookGroup.position.set(-w / 2 - 0.2, 0.05, -0.2);

  } else if (pre === 'hands-blue') {
    state.composition = 'standing';
    bookGroup.rotation.x = 0.28;
    bookGroup.rotation.y = -0.45;
    bookGroup.rotation.z = -0.12;
    bookGroup.position.set(-w / 2 + 0.1, 0.65, 0.45);

  } else if (pre === 'hands-sky') {
    state.composition = 'standing';
    bookGroup.rotation.x = 0.02;
    bookGroup.rotation.y = -0.05;
    bookGroup.rotation.z = 0.0;
    bookGroup.position.set(-w / 2, 0.95, 0.0);

  } else if (pre === 'hands-cotton') {
    state.composition = 'standing';
    bookGroup.rotation.x = 0.15;
    bookGroup.rotation.y = -0.40;
    bookGroup.rotation.z = -0.05;
    bookGroup.position.set(-w / 2, 1.25, 0.15);

  } else if (pre === 'wood-angle') {
    state.composition = 'lying';
    bookGroup.rotation.x = -Math.PI / 2;
    bookGroup.rotation.z = Math.PI / 6;
    bookGroup.position.set(-0.3, thickness / 2, 0.2);

  } else if (pre === 'marble-desk') {
    state.composition = 'lying';
    bookGroup.rotation.x = -Math.PI / 2;
    bookGroup.rotation.z = -Math.PI / 4;
    bookGroup.position.set(-0.2, thickness / 2, -0.4);

  } else if (pre === 'creative-studio') {
    state.composition = 'standing';
    bookGroup.rotation.x = 0;
    bookGroup.rotation.y = 0.45;
    bookGroup.rotation.z = 0;
    bookGroup.position.set(-w / 2, 0, 0.5);

  } else if (pre === 'modern-study') {
    state.composition = 'standing';
    bookGroup.rotation.x = 0.1;
    bookGroup.rotation.y = -0.3;
    bookGroup.rotation.z = -0.05;
    bookGroup.position.set(-w / 2 + 0.2, 0, -0.2);

  } else if (pre === 'studio' || pre === 'midnight-mood') {
    state.composition = 'standing';
    bookGroup.position.set(-w / 2, 0, 0);
  }

  // Apply manual user nudges (alignment offset adjustments)
  bookGroup.position.x += state.bookNudgeX;
  bookGroup.position.y += state.bookNudgeY;
  bookGroup.position.z += state.bookNudgeZ;
  bookGroup.rotation.y += (state.bookNudgeRy * Math.PI) / 180;
  bookGroup.scale.setScalar(state.bookNudgeScale);

  // Sync handsGroup transforms to match the book
  update3DHands();

  // Frame the camera perfectly
  frameCameraOnBook(pre);
}

// --- BOOK COMPOSITION PLACEMENTS ---
function applyComposition() {
  alignPresetCamera();
}

// --- PHOTOSHOOT PRESETS & LIGHTING ---

const propPresetDefaults = {
  'wood-angle': {
    'plant': { px: -4.0, py: 0, pz: -2.8, rx: 0, ry: 0, rz: 0, s: 1.0, visible: true },
    'teacup': { px: 5.0, py: 0, pz: -2.5, rx: 0, ry: 0, rz: 0, s: 1.0, visible: true },
    'pen': { px: 1.8, py: 0.06, pz: 3.2, rx: 0, ry: 0, rz: 0, s: 1.0, visible: true },
    'glasses': { px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0, s: 1.0, visible: false },
    'camera': { px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0, s: 1.0, visible: false },
    'bottle': { px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0, s: 1.0, visible: false },
    'avocado': { px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0, s: 1.0, visible: false },
    'scale': { px: -5.0, py: 0, pz: 1.0, rx: 0, ry: 0.2, rz: 0, s: 1.0, visible: true },
    'armchair': { px: -9.5, py: 0, pz: -8.0, rx: 0, ry: 0.5, rz: 0, s: 1.0, visible: true },
    'lantern': { px: 5.5, py: 0, pz: 1.5, rx: 0, ry: -0.3, rz: 0, s: 1.0, visible: true }
  },
  'marble-desk': {
    'plant': { px: 4.5, py: 0, pz: -3.2, rx: 0, ry: 0, rz: 0, s: 1.0, visible: true },
    'teacup': { px: -3.2, py: 0, pz: 2.5, rx: 0, ry: 0, rz: 0, s: 1.0, visible: true },
    'pen': { px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0, s: 1.0, visible: false },
    'glasses': { px: 1.5, py: 0.05, pz: 2.0, rx: 0, ry: -0.4, rz: 0, s: 1.0, visible: true },
    'camera': { px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0, s: 1.0, visible: false },
    'bottle': { px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0, s: 1.0, visible: false },
    'avocado': { px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0, s: 1.0, visible: false },
    'scale': { px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0, s: 1.0, visible: false },
    'armchair': { px: -11.0, py: 0, pz: -9.0, rx: 0, ry: 0.8, rz: 0, s: 1.0, visible: true },
    'lantern': { px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0, s: 1.0, visible: false }
  },
  'creative-studio': {
    'plant': { px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0, s: 1.0, visible: false },
    'teacup': { px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0, s: 1.0, visible: false },
    'pen': { px: 2.2, py: 0.06, pz: 1.5, rx: 0, ry: 0.4, rz: 0, s: 1.0, visible: true },
    'glasses': { px: -1.8, py: 0.05, pz: 2.8, rx: 0, ry: -0.2, rz: 0, s: 1.0, visible: true },
    'camera': { px: -3.8, py: 0, pz: -2.0, rx: 0, ry: 0.8, rz: 0, s: 1.0, visible: true },
    'bottle': { px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0, s: 1.0, visible: false },
    'avocado': { px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0, s: 1.0, visible: false },
    'scale': { px: 4.8, py: 0, pz: -2.8, rx: 0, ry: -0.5, rz: 0, s: 1.0, visible: true },
    'armchair': { px: -9.0, py: 0, pz: -8.0, rx: 0, ry: 0.6, rz: 0, s: 1.0, visible: true },
    'lantern': { px: 2.5, py: 0, pz: -3.5, rx: 0, ry: 0.2, rz: 0, s: 1.0, visible: true }
  },
  'modern-study': {
    'plant': { px: 4.2, py: 0, pz: -3.0, rx: 0, ry: 0, rz: 0, s: 1.0, visible: true },
    'teacup': { px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0, s: 1.0, visible: false },
    'pen': { px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0, s: 1.0, visible: false },
    'glasses': { px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0, s: 1.0, visible: false },
    'camera': { px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0, s: 1.0, visible: false },
    'bottle': { px: -3.5, py: 0, pz: -2.0, rx: 0, ry: 0, rz: 0, s: 1.0, visible: true },
    'avocado': { px: 2.5, py: 0, pz: 2.2, rx: 0.2, ry: 0.8, rz: -0.1, s: 1.0, visible: true },
    'scale': { px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0, s: 1.0, visible: false },
    'armchair': { px: -10.0, py: 0, pz: -8.5, rx: 0, ry: 0.4, rz: 0, s: 1.0, visible: true },
    'lantern': { px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0, s: 1.0, visible: false }
  },
  'concrete-leaning-3d': {
    'plant': { px: 4.5, py: 0, pz: -2.8, rx: 0, ry: 0, rz: 0, s: 1.0, visible: false },
    'teacup': { px: -3.5, py: 0, pz: 2.2, rx: 0, ry: 0.5, rz: 0, s: 1.0, visible: false },
    'pen': { px: 1.5, py: 0.06, pz: 1.8, rx: 0, ry: -0.4, rz: 0, s: 1.0, visible: false },
    'glasses': { px: -1.0, py: 0.05, pz: 2.5, rx: 0, ry: 0.2, rz: 0, s: 1.0, visible: false },
    'camera': { px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0, s: 1.0, visible: false },
    'bottle': { px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0, s: 1.0, visible: false },
    'avocado': { px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0, s: 1.0, visible: false },
    'scale': { px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0, s: 1.0, visible: false },
    'armchair': { px: -11.0, py: 0, pz: -8.0, rx: 0, ry: 0.7, rz: 0, s: 1.0, visible: false },
    'lantern': { px: 5.5, py: 0, pz: 1.0, rx: 0, ry: -0.2, rz: 0, s: 1.0, visible: false }
  }
};

function applyPropPresetDefaults(pre) {
  const defaults = propPresetDefaults[pre];
  loadedProps.forEach(p => {
    const key = p.name.toLowerCase();
    if (defaults && defaults[key]) {
      const d = defaults[key];
      p.group.position.set(d.px, d.py, d.pz);
      p.group.rotation.set(d.rx, d.ry, d.rz);
      p.group.scale.setScalar(d.s);
      p.group.visible = d.visible;
    } else {
      p.group.visible = false;
    }
  });
}

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
    bgColor = new THREE.Color('#efebe9'); // Warm cozy studio wall
    floorColor = '#ffffff'; // White base color under wood texture map
    floorMetal = 0.1;
    floorRough = 0.45;
    if (propsGroup) propsGroup.visible = true;
    if (leafShadowPlane) leafShadowPlane.visible = false;
  } else if (pre === 'marble-desk') {
    bgColor = new THREE.Color('#eae6e8'); // elegant warm-grey background
    floorColor = '#ffffff';
    floorMetal = 0.2;
    floorRough = 0.15; // glossy marble!
    if (propsGroup) propsGroup.visible = true;
    if (leafShadowPlane) leafShadowPlane.visible = false;
  } else if (pre === 'creative-studio') {
    bgColor = new THREE.Color('#1c1a1a'); // dark moody studio wall
    floorColor = '#424242'; // dark grey concrete/slate
    floorMetal = 0.05;
    floorRough = 0.6;
    if (propsGroup) propsGroup.visible = true;
    if (leafShadowPlane) leafShadowPlane.visible = false;
  } else if (pre === 'modern-study') {
    bgColor = new THREE.Color('#f5f5f3'); // crisp bright white/grey wall
    floorColor = '#ffffff';
    floorMetal = 0.05;
    floorRough = 0.5;
    if (propsGroup) propsGroup.visible = true;
    if (leafShadowPlane) leafShadowPlane.visible = false;
  } else if (pre === 'concrete-leaning-3d') {
    bgColor = new THREE.Color('#948f8a'); // Warm concrete wall color
    floorColor = '#a8a39e';
    floorMetal = 0.05;
    floorRough = 0.55;
    
    // Force sharp sunlight shadow configurations programmatically
    state.shadowSoftness = 0.15;
    const softInput = document.getElementById('input-shadow-softness');
    if (softInput) softInput.value = 0.15;
    const softVal = document.getElementById('shadow-val');
    if (softVal) softVal.textContent = 'Sharp';

    if (propsGroup) propsGroup.visible = true;
    if (leafShadowPlane) leafShadowPlane.visible = true;
  } else if (pre === 'hands-cotton') {
    bgColor = new THREE.Color('#eae3d9'); // Soft neutral warm linen studio color
    floorColor = '#f5efe6';
    floorMetal = 0.02;
    floorRough = 0.85;
    if (propsGroup) propsGroup.visible = false;
    if (leafShadowPlane) leafShadowPlane.visible = true;
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
      floorPlane.material = new THREE.MeshStandardMaterial({
        color: new THREE.Color(floorColor),
        map: generateWoodTexture(),
        roughness: floorRough,
        metalness: floorMetal
      });
    } else if (pre === 'marble-desk') {
      const textureLoader = new THREE.TextureLoader();
      const marbleTex = textureLoader.load('/backdrop_marble.png');
      marbleTex.wrapS = THREE.RepeatWrapping;
      marbleTex.wrapT = THREE.RepeatWrapping;
      marbleTex.repeat.set(2, 2);
      floorPlane.material = new THREE.MeshStandardMaterial({
        color: new THREE.Color(floorColor),
        map: marbleTex,
        roughness: floorRough,
        metalness: floorMetal
      });
    } else if (pre === 'creative-studio' || pre === 'concrete-leaning-3d') {
      const tex = concretePhotoTexture || generateConcreteTexture(floorColor, floorRough);
      floorPlane.material = new THREE.MeshStandardMaterial({
        color: new THREE.Color(pre === 'concrete-leaning-3d' ? '#eae2d8' : '#ffffff'), // tint concrete texture to warm sandstone!
        map: tex,
        bumpMap: tex, // 3D micro-grain bump reflections
        bumpScale: pre === 'concrete-leaning-3d' ? 0.12 : 0.03, // highly intense bump depth!
        roughness: pre === 'concrete-leaning-3d' ? 0.95 : floorRough, // unpolished matte texture
        metalness: 0.0
      });
    } else if (pre === 'modern-study') {
      floorPlane.material = new THREE.MeshStandardMaterial({
        color: new THREE.Color(floorColor),
        map: generateLightWoodTexture(),
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

  // Update Back Wall Material, Rotation, and Position
  if (backWallPlane) {
    if (isPhotoBackdrop) {
      backWallPlane.visible = false;
    } else {
      backWallPlane.visible = true;
      backWallPlane.material.dispose();
      
      // Position and rotate wall diagonally for concrete-leaning-3d to match photo perspective
      if (pre === 'concrete-leaning-3d') {
        backWallPlane.rotation.y = -Math.PI / 6.5; // diagonal rotation (approx -28 degrees)
        backWallPlane.position.set(-6.0, 75.0, -9.0); // shift left and forward to meet the ground line
      } else {
        backWallPlane.rotation.y = 0; // standard flat wall facing camera
        backWallPlane.position.set(0, 75.0, -18.0); // push back to origin wall boundary
      }

      if (pre === 'creative-studio' || pre === 'concrete-leaning-3d') {
        const wallColor = pre === 'creative-studio' ? '#424242' : '#9e9994';
        const wallRough = pre === 'creative-studio' ? 0.8 : 0.7;
        const tex = concretePhotoTexture || generateConcreteTexture(wallColor, wallRough);
        backWallPlane.material = new THREE.MeshStandardMaterial({
          color: new THREE.Color(pre === 'concrete-leaning-3d' ? '#eae2d8' : '#ffffff'), // tint concrete texture to warm sandstone!
          map: tex,
          bumpMap: tex, // 3D wall plaster bump relief
          bumpScale: pre === 'concrete-leaning-3d' ? 0.15 : 0.04, // very deep bump scale!
          roughness: pre === 'concrete-leaning-3d' ? 0.95 : wallRough, // unpolished vertical wall
          metalness: 0.0
        });
      } else {
        backWallPlane.material = new THREE.MeshStandardMaterial({
          color: bgColor.clone(),
          roughness: 0.9,
          metalness: 0.0
        });
      }
      backWallPlane.receiveShadow = true;
      backWallPlane.castShadow = false;
    }
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

  // Apply default prop visibility/transform based on preset
  applyPropPresetDefaults(pre);

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
      
      let makeTransparent = false;
      
      if (pre === 'hands-blue') {
        // Key out background cyan/blue:
        const isCyan = (b > 120 && b > r * 1.3) || (g > 140 && g > r * 1.2);
        // Key out the old teal book cover in the photo:
        const isTealBook = (r < 110 && g > 75 && b > 75) || (r < 120 && g > 110 && b > 120);
        if (isCyan || isTealBook) {
          makeTransparent = true;
        }
      } else if (pre === 'hands-sky') {
        // Key out sky blue and white clouds:
        const isSkyBlue = (b > 120 && b > r * 1.05) || (r > 180 && g > 180 && b > 180);
        // Key out the old orange/yellow book cover in the photo:
        const isOrangeBook = (r > 130 && g > 90 && b < 120 && r > b * 1.2);
        if (isSkyBlue || isOrangeBook) {
          makeTransparent = true;
        }
      }
      
      if (makeTransparent) {
        data[i + 3] = 0; // Set pixel to transparent
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

  // Dispose existing lights and targets from the scene graph
  Object.keys(lights).forEach(k => scene.remove(lights[k]));
  lights = {};

  const pre = state.preset;
  const rad = (state.lightRotation * Math.PI) / 180;
  const intensity = state.lightIntensity;
  
  // Set light distance to 35.0 inches to ensure it remains well outside the scene bounding box
  const distance = 35.0;
  const lx = Math.cos(rad) * distance;
  const lz = Math.sin(rad) * distance;

  const targetY = (state.height * INCH_TO_THREE) / 2;

  function makeDir(color, mul, px, py, pz, castShadow = false, range = 15.0) {
    const d = new THREE.DirectionalLight(color, mul * intensity);
    d.position.set(px, py, pz);
    d.target.position.set(0, targetY, 0);
    
    // Add both light and its target to registry to allow clean cleanup on rebuild
    const keyId = 'dirLight_' + Math.random().toString(36).substr(2, 9);
    const targetId = 'dirTarget_' + Math.random().toString(36).substr(2, 9);
    lights[keyId] = d;
    lights[targetId] = d.target;

    if (castShadow) {
      d.castShadow = true;
      d.shadow.mapSize.width = 4096; // 4K shadow mapping for fine-detail soft rendering
      d.shadow.mapSize.height = 4096;
      d.shadow.camera.near = 1.0;
      d.shadow.camera.far = 100.0;
      
      d.shadow.camera.left = -range;
      d.shadow.camera.right = range;
      d.shadow.camera.top = range;
      d.shadow.camera.bottom = -range;
      
      // normalBias prevents self-shadow acne on thin sheets / hard covers
      d.shadow.bias = -0.0004;
      d.shadow.normalBias = 0.05;
      d.shadow.radius = Math.max(1.0, state.shadowSoftness * 5.0);
    }
    return d;
  }

  if (pre === 'studio' || pre === 'hands-blue' || pre === 'hands-cotton') {
    lights.ambient = new THREE.AmbientLight(0xffffff, 0.55 * intensity);
    makeDir(0xffffff, 1.4, lx, 25.0, lz, true, 12.0);
    makeDir(0xe2e8f0, 0.45, -lx, 15.0, -lz, false);
    
    const rim = new THREE.SpotLight(0xffffff, 0.8 * intensity, 40, Math.PI / 6, 0.5, 1);
    rim.position.set(0, 22, -22);
    rim.target.position.set(0, targetY, 0);
    lights.rim = rim;
    lights.rimTarget = rim.target;

  } else if (pre === 'clean-flatlay') {
    lights.ambient = new THREE.AmbientLight(0xfffaf0, 0.7 * intensity);
    makeDir(0xfffdf9, 1.25, lx, 28.0, lz, true, 12.0);
    makeDir(0xffffff, 0.35, -lx, 15.0, -lz, false);

  } else if (pre === 'concrete-wall') {
    lights.ambient = new THREE.AmbientLight(0xfff7e6, 0.45 * intensity);
    makeDir(0xffeedd, 2.3, lx, 20.0, lz, true, 15.0);
    makeDir(0xe0e7ff, 0.55, -lx, 12.0, -lz, false);

  } else if (pre === 'concrete-leaning-3d') {
    lights.ambient = new THREE.AmbientLight(0xd9e6ff, 0.55 * intensity); // Cool blue sky dome ambient fill
    makeDir(0xfff5ea, 3.2, lx, 24.0, lz, true, 18.0); // Blazing hot direct sunlight
    makeDir(0xd0e0ff, 0.6, -lx, 15.0, -lz, false); // Cool sky shadow fill bounce

  } else if (pre === 'hands-sky') {
    lights.ambient = new THREE.AmbientLight(0xdbeafe, 0.65 * intensity);
    makeDir(0xffffff, 1.8, lx, 28.0, lz, true, 12.0);
    makeDir(0xbfdbfe, 0.5, -lx, 15.0, -lz, false);

  } else if (pre === 'midnight-mood') {
    lights.ambient = new THREE.AmbientLight(0x181829, 0.25 * intensity);
    makeDir(0xd8b4fe, 0.85, lx, 22.0, lz, true, 12.0);
    makeDir(0x06b6d4, 2.0, -15, 12, -15, false);
    makeDir(0xec4899, 1.7, 15, 10, -15, false);

  } else if (pre === 'wood-angle') {
    lights.ambient = new THREE.AmbientLight(0xffecd9, 0.5 * intensity);
    makeDir(0xfff1e2, 1.5, lx, 24.0, lz, true, 18.0);

    const spot = new THREE.SpotLight(0xffdcb3, 2.0 * intensity, 40, Math.PI / 4, 0.35, 0.8);
    spot.position.set(2, 22, 5);
    spot.target.position.set(0, 0, 0);
    spot.castShadow = true;
    spot.shadow.mapSize.set(2048, 2048);
    spot.shadow.camera.near = 1.0;
    spot.shadow.camera.far = 40.0;
    spot.shadow.bias = -0.0004;
    spot.shadow.normalBias = 0.05;
    spot.shadow.radius = Math.max(1.5, state.shadowSoftness * 5.0);
    
    lights.spot = spot;
    lights.spotTarget = spot.target;

  } else if (pre === 'marble-desk') {
    lights.ambient = new THREE.AmbientLight(0xfff0f5, 0.6 * intensity);
    makeDir(0xfff5fa, 1.4, lx, 24.0, lz, true, 18.0);
    makeDir(0xe6e6fa, 0.5, -lx, 15.0, -lz, false);

  } else if (pre === 'creative-studio') {
    lights.ambient = new THREE.AmbientLight(0x222020, 0.35 * intensity);
    makeDir(0xffdcb3, 1.9, lx, 26.0, lz, true, 18.0);
    makeDir(0x708090, 0.4, -lx, 15.0, -lz, false);

  } else if (pre === 'modern-study') {
    lights.ambient = new THREE.AmbientLight(0xf0f4f8, 0.7 * intensity);
    makeDir(0xffffff, 1.6, lx, 28.0, lz, true, 18.0);
    makeDir(0xe6f2ff, 0.5, -lx, 15.0, -lz, false);
  }

  // Configure leaf shadow plane position for 3D sunlight stencils
  if (leafShadowPlane) {
    if (pre === 'concrete-leaning-3d') {
      leafShadowPlane.visible = true;
      leafShadowPlane.castShadow = true;
      
      const targetPos = new THREE.Vector3(0, targetY, 0);
      const lightPos = new THREE.Vector3(lx, 24.0, lz);
      
      const planePos = new THREE.Vector3().lerpVectors(targetPos, lightPos, 0.45);
      leafShadowPlane.position.copy(planePos);
      leafShadowPlane.lookAt(lightPos);
      leafShadowPlane.scale.set(7.5, 7.5, 1.0);
    } else {
      leafShadowPlane.visible = false;
      leafShadowPlane.castShadow = false;
    }
  }

  // Add all active lights and targets to the scene graph
  Object.keys(lights).forEach(k => scene.add(lights[k]));
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
  loadConcretePhotoTexture(); // Async load and crop clean concrete textures from photo backdrop
  loadHandModels();           // Async load left and right 3D hand models

  // 6. Floor Plane
  const floorGeom = new THREE.PlaneGeometry(100, 100);
  floorPlane = new THREE.Mesh(floorGeom, new THREE.MeshStandardMaterial());
  floorPlane.rotation.x = -Math.PI / 2;
  floorPlane.position.y = 0;
  floorPlane.receiveShadow = true;
  scene.add(floorPlane);

  // 6a. Back Wall Plane (large wall to cover side angles completely)
  const backWallGeom = new THREE.PlaneGeometry(300, 150);
  backWallPlane = new THREE.Mesh(backWallGeom, new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0.0 }));
  backWallPlane.position.set(0, 75.0, -18.0); // Z = -18, centered, Y = 75
  backWallPlane.receiveShadow = true;
  backWallPlane.castShadow = false;
  scene.add(backWallPlane);

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

  // 6d. 3D Hands Group
  handsGroup = new THREE.Group();
  scene.add(handsGroup);

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
    alphaTest: 0.5,
    colorWrite: false, // make it invisible to color pass
    side: THREE.DoubleSide
  });
  const leafGeom = new THREE.PlaneGeometry(3, 3);
  leafShadowPlane = new THREE.Mesh(leafGeom, leafMat);
  leafShadowPlane.castShadow = true; // allow casting gobo shadow cookies!
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

    // Book alignment nudges UI sync
    const nudgeX = document.getElementById('input-book-nudge-x');
    if (nudgeX) {
      nudgeX.value = state.bookNudgeX;
      document.getElementById('book-nudge-x-val').textContent = state.bookNudgeX.toFixed(2) + '"';
    }
    const nudgeY = document.getElementById('input-book-nudge-y');
    if (nudgeY) {
      nudgeY.value = state.bookNudgeY;
      document.getElementById('book-nudge-y-val').textContent = state.bookNudgeY.toFixed(2) + '"';
    }
    const nudgeZ = document.getElementById('input-book-nudge-z');
    if (nudgeZ) {
      nudgeZ.value = state.bookNudgeZ;
      document.getElementById('book-nudge-z-val').textContent = state.bookNudgeZ.toFixed(2) + '"';
    }
    const nudgeRy = document.getElementById('input-book-nudge-ry');
    if (nudgeRy) {
      nudgeRy.value = state.bookNudgeRy;
      document.getElementById('book-nudge-ry-val').textContent = state.bookNudgeRy + '°';
    }
    const nudgeScale = document.getElementById('input-book-nudge-scale');
    if (nudgeScale) {
      nudgeScale.value = state.bookNudgeScale;
      document.getElementById('book-nudge-scale-val').textContent = state.bookNudgeScale.toFixed(2) + 'x';
    }
  })();
  // ============================================================

  // ============================================================
  //  SCENE OUTLINER + TRANSFORM INSPECTOR
  // ============================================================

  // Registry of all scene objects — populated here and refreshed
  // when new props are loaded by create3DProps()
  const ICONS = {
    Book: '📖', Plant: '🌿', Teacup: '☕', Glasses: '👓',
    Camera: '📷', Bottle: '🍼', Avocado: '🥑', Scale: '⚖️',
    Armchair: '🪑', Lantern: '🏮', Pen: '🖊️',
    Floor: '⬜', Wall: '🧱'
  };

  // Selection state
  let selectedEntry = null;      // { id, name, group, locked, visible, defaultPos, defaultRot, defaultScale }
  let selectionBox = null;       // THREE.BoxHelper for outline

  // Build the registry from current scene objects
  function buildRegistry() {
    const reg = [];
    
    function ensureDefaults(g) {
      if (!g.userData.defaultPos) g.userData.defaultPos = g.position.clone();
      if (!g.userData.defaultRot) g.userData.defaultRot = g.rotation.clone();
      if (!g.userData.defaultScale) g.userData.defaultScale = g.scale.clone();
    }

    if (bookGroup) {
      ensureDefaults(bookGroup);
      reg.push({
        id: 'book', name: 'Book', group: bookGroup,
        locked: !!bookGroup.userData.locked,
        visible: bookGroup.visible,
        defaultPos: bookGroup.userData.defaultPos,
        defaultRot: bookGroup.userData.defaultRot,
        defaultScale: bookGroup.userData.defaultScale
      });
    }
    loadedProps.forEach(p => {
      ensureDefaults(p.group);
      reg.push({
        id: p.name.toLowerCase(), name: p.name, group: p.group,
        locked: !!p.group.userData.locked,
        visible: p.group.visible,
        defaultPos: p.group.userData.defaultPos,
        defaultRot: p.group.userData.defaultRot,
        defaultScale: p.group.userData.defaultScale
      });
    });
    if (backWallPlane) {
      ensureDefaults(backWallPlane);
      if (backWallPlane.userData.locked === undefined) {
        backWallPlane.userData.locked = true;
      }
      reg.push({
        id: 'wall', name: 'Wall', group: backWallPlane,
        locked: !!backWallPlane.userData.locked,
        visible: backWallPlane.visible,
        defaultPos: backWallPlane.userData.defaultPos,
        defaultRot: backWallPlane.userData.defaultRot,
        defaultScale: backWallPlane.userData.defaultScale
      });
    }
    if (floorPlane) {
      ensureDefaults(floorPlane);
      if (floorPlane.userData.locked === undefined) {
        floorPlane.userData.locked = true; // Floor is locked by default
      }
      reg.push({
        id: 'floor', name: 'Floor', group: floorPlane,
        locked: !!floorPlane.userData.locked,
        visible: floorPlane.visible,
        defaultPos: floorPlane.userData.defaultPos,
        defaultRot: floorPlane.userData.defaultRot,
        defaultScale: floorPlane.userData.defaultScale
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
      visBtn.className = 'outliner-btn';
      visBtn.title = entry.visible ? 'Hide' : 'Show';
      visBtn.textContent = entry.visible ? '👁' : '🚫';
      visBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        entry.group.visible = !entry.group.visible;
        saveSettings();
        renderOutliner();
      });

      const lockBtn = document.createElement('button');
      lockBtn.className = 'outliner-btn' + (entry.locked ? ' active' : '');
      lockBtn.title = entry.locked ? 'Unlock' : 'Lock position';
      lockBtn.textContent = entry.locked ? '🔒' : '🔓';
      lockBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        entry.group.userData.locked = !entry.group.userData.locked;
        saveSettings();
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
    const isLocked = !!g.userData.locked;
    const inputs = ['inp-px', 'inp-py', 'inp-pz', 'inp-rx', 'inp-ry', 'inp-rz', 'inp-s'];
    inputs.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.disabled = isLocked;
    });
    const resetBtn = document.getElementById('inspector-reset-btn');
    if (resetBtn) resetBtn.disabled = isLocked;

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
    if (found) {
      selectEntry(found);
    } else {
      selectEntry(null);
    }
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
  const perfectRenderBtn = document.getElementById('perfect-render-btn');
  
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

  const exportConfigBtn = document.getElementById('export-config-btn');
  const importConfigBtn = document.getElementById('import-config-btn');
  const importConfigFile = document.getElementById('import-config-file');

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

  // Book alignment nudge event listeners
  const inputNudgeX = document.getElementById('input-book-nudge-x');
  const inputNudgeY = document.getElementById('input-book-nudge-y');
  const inputNudgeZ = document.getElementById('input-book-nudge-z');
  const inputNudgeRy = document.getElementById('input-book-nudge-ry');
  const inputNudgeScale = document.getElementById('input-book-nudge-scale');

  const nudgeXVal = document.getElementById('book-nudge-x-val');
  const nudgeYVal = document.getElementById('book-nudge-y-val');
  const nudgeZVal = document.getElementById('book-nudge-z-val');
  const nudgeRyVal = document.getElementById('book-nudge-ry-val');
  const nudgeScaleVal = document.getElementById('book-nudge-scale-val');

  if (inputNudgeX) {
    inputNudgeX.addEventListener('input', (e) => {
      state.bookNudgeX = parseFloat(e.target.value);
      nudgeXVal.innerText = `${state.bookNudgeX.toFixed(2)}"`;
      alignPresetCamera();
      saveSettings();
    });
  }
  if (inputNudgeY) {
    inputNudgeY.addEventListener('input', (e) => {
      state.bookNudgeY = parseFloat(e.target.value);
      nudgeYVal.innerText = `${state.bookNudgeY.toFixed(2)}"`;
      alignPresetCamera();
      saveSettings();
    });
  }
  if (inputNudgeZ) {
    inputNudgeZ.addEventListener('input', (e) => {
      state.bookNudgeZ = parseFloat(e.target.value);
      nudgeZVal.innerText = `${state.bookNudgeZ.toFixed(2)}"`;
      alignPresetCamera();
      saveSettings();
    });
  }
  if (inputNudgeRy) {
    inputNudgeRy.addEventListener('input', (e) => {
      state.bookNudgeRy = parseInt(e.target.value);
      nudgeRyVal.innerText = `${state.bookNudgeRy}°`;
      alignPresetCamera();
      saveSettings();
    });
  }
  if (inputNudgeScale) {
    inputNudgeScale.addEventListener('input', (e) => {
      state.bookNudgeScale = parseFloat(e.target.value);
      nudgeScaleVal.innerText = `${state.bookNudgeScale.toFixed(2)}x`;
      alignPresetCamera();
      saveSettings();
    });
  }

  function applyCameraShot(shotName) {
    if (!camera || !controls) return;
    
    const w = state.width * INCH_TO_THREE;
    const h = state.height * INCH_TO_THREE;
    const d = state.spineWidth * INCH_TO_THREE;
    const maxDim = Math.max(w, h);
    
    const isLying = state.composition === 'lying' || state.preset === 'clean-flatlay' || state.preset === 'wood-angle' || state.preset === 'marble-desk';
    
    if (isLying) {
      // Book is lying flat on the floor (rotated -Math.PI / 2 on X)
      if (shotName === 'front') {
        // Front cover is facing UP
        camera.position.set(0, maxDim * 1.4, 0.01);
        controls.target.set(0, 0, 0);
      } else if (shotName === 'spine') {
        // Spine is facing LEFT (negative X)
        camera.position.set(-maxDim * 1.2, maxDim * 0.3, 0);
        controls.target.set(0, 0, 0);
      } else if (shotName === 'back') {
        // Back cover is facing down, show nice low 3/4 angle from the back
        camera.position.set(0, maxDim * 0.4, -maxDim * 1.2);
        controls.target.set(0, 0, 0);
      } else if (shotName === 'top') {
        // Top edge is facing BACK (negative Z)
        camera.position.set(0, maxDim * 0.3, -maxDim * 1.2);
        controls.target.set(0, 0, 0);
      } else { // 'three-quarter'
        camera.position.set(-w * 0.5, maxDim * 0.8, maxDim * 1.0);
        controls.target.set(0, 0, 0);
      }
    } else {
      // Book is standing vertically
      if (shotName === 'front') {
        camera.position.set(0, h / 2, maxDim * 1.3);
        controls.target.set(0, h / 2, 0);
      } else if (shotName === 'spine') {
        camera.position.set(-maxDim * 1.2, h / 2, 0);
        controls.target.set(0, h / 2, 0);
      } else if (shotName === 'back') {
        camera.position.set(0, h / 2, -maxDim * 1.3);
        controls.target.set(0, h / 2, 0);
      } else if (shotName === 'top') {
        camera.position.set(0, h + maxDim * 0.8, 0.01);
        controls.target.set(0, h / 2, 0);
      } else { // 'three-quarter'
        camera.position.set(maxDim * 0.8, h * 0.6, maxDim * 1.1);
        controls.target.set(0, h * 0.4, 0);
      }
    }
    controls.update();
  }

  function triggerCapture(isPerfectFrame = false) {
    spinner.classList.remove('hidden');
    showToast(isPerfectFrame ? '⭐ Rendering perfect-framed master snapshot...' : '📸 Rendering studio-quality snapshot...');
  
    // Save original camera transforms
    const originalPos = camera.position.clone();
    const originalTarget = controls.target.clone();

    // Small delay to let spinner display
    setTimeout(() => {
      try {
        const pre = state.preset;
        if (isPerfectFrame) {
          frameCameraOnBook(pre);
        }

        const scale = state.exportScale;
        const container = document.getElementById('canvas-container');
        const clientW = container.clientWidth;
        const clientH = container.clientHeight;
        
        // Target high-res dims (independent of screen devicePixelRatio)
        const targetW = clientW * scale;
        const targetH = clientH * scale;
  
        // Hide helpers temporarily
        const originalGridVisible = gridHelper.visible;
        gridHelper.visible = false;
        if (window._axesHelper) window._axesHelper.visible = false;
        if (selectionBox) selectionBox.visible = false;
  
        // Manage transparency
        let originalBg = scene.background;
        if (state.exportBg === 'transparent') {
          scene.background = null;
          renderer.setClearColor(0x000000, 0);
        }
  
        // Capture original pixel ratio to prevent duplicate multiplication
        const originalPixelRatio = renderer.getPixelRatio();
        renderer.setPixelRatio(1.0);
        renderer.setSize(targetW, targetH, false);
        camera.aspect = targetW / targetH;
        camera.updateProjectionMatrix();
  
        // Render high-res frames
        renderer.render(scene, camera);
  
        // Composite and download the final high-res snapshot
        compositeAndDownload(renderer.domElement, targetW, targetH, () => {
          // Restore renderer settings
          renderer.setPixelRatio(originalPixelRatio);
          renderer.setSize(clientW, clientH, true);
          camera.aspect = clientW / clientH;
          camera.updateProjectionMatrix();
          
          gridHelper.visible = originalGridVisible;
          if (window._axesHelper) window._axesHelper.visible = state.showGrid;
          if (selectionBox) selectionBox.visible = true;
          
          if (state.exportBg === 'transparent') {
            scene.background = originalBg;
          }

          // Restore original camera angles
          camera.position.copy(originalPos);
          controls.target.copy(originalTarget);
          controls.update();
          
          // Re-render display viewport
          renderer.render(scene, camera);
        });
  
      } catch (err) {
        console.error(err);
        showToast('❌ Failed to capture render.');
        spinner.classList.add('hidden');

        // Restore camera and renderer in case of crash
        if (renderer) {
          renderer.setPixelRatio(window.devicePixelRatio || 1.0);
          const container = document.getElementById('canvas-container');
          if (container) {
            renderer.setSize(container.clientWidth, container.clientHeight, true);
          }
        }
        camera.position.copy(originalPos);
        controls.target.copy(originalTarget);
        controls.update();
      }
    }, 100);
  }

  // Camera presets
  camButtons.forEach(btn => {
    btn.addEventListener('click', (e) => {
      camButtons.forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');
      applyCameraShot(e.target.getAttribute('data-cam'));
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
    triggerCapture(false);
  });

  if (perfectRenderBtn) {
    perfectRenderBtn.addEventListener('click', () => {
      triggerCapture(true);
    });
  }

  const exportGlbBtn = document.getElementById('export-glb-btn');
  if (exportGlbBtn) {
    exportGlbBtn.addEventListener('click', () => {
      const spinner = document.getElementById('spinner');
      if (spinner) spinner.classList.remove('hidden');
      showToast('📦 Exporting 3D scene to GLB for Blender...');
      
      setTimeout(() => {
        try {
          const exporter = new GLTFExporter();
          
          // Hide editor outline helpers temporarily
          const originalGridVisible = gridHelper ? gridHelper.visible : false;
          if (gridHelper) gridHelper.visible = false;
          if (window._axesHelper) window._axesHelper.visible = false;
          if (selectionBox) selectionBox.visible = false;
          
          const options = {
            binary: true,
            animations: [],
            truncateDrawRange: true
          };
          
          exporter.parse(
            scene,
            (gltf) => {
              // Restore editor outline helpers
              if (gridHelper) gridHelper.visible = originalGridVisible;
              if (window._axesHelper) window._axesHelper.visible = state.showGrid;
              if (selectionBox) selectionBox.visible = true;
              
              // Trigger browser download
              const blob = new Blob([gltf], { type: 'application/octet-stream' });
              const link = document.createElement('a');
              link.download = `BookStudio3D_Scene_${state.bookType}_${Date.now()}.glb`;
              link.href = URL.createObjectURL(blob);
              link.click();
              
              showToast('🎉 Scene exported! Open Blender, go to File -> Import -> glTF 2.0.');
              if (spinner) spinner.classList.add('hidden');
            },
            (err) => {
              console.error(err);
              showToast('❌ GLB export failed.');
              if (spinner) spinner.classList.add('hidden');
            },
            options
          );
        } catch (e) {
          console.error(e);
          showToast('❌ GLB export failed.');
          if (spinner) spinner.classList.add('hidden');
        }
      }, 100);
    });
  }
  
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
        
        // Draw WebGL book (including shadow catcher floor/wall) on top with proper scaling
        compCtx.drawImage(webglCanvas, 0, 0, targetW, targetH);
        
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
      
      // Draw WebGL book canvas with proper scaling
      compCtx.drawImage(webglCanvas, 0, 0, targetW, targetH);
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
        if (found.group.userData.locked) {
          showToast(`🔒 ${found.name} is locked. Unlock in outliner to drag.`);
          return;
        }
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

  // --- CONFIG IMPORT / EXPORT SYSTEM ---
  function exportConfig() {
    try {
      const data = {
        state: {
          bookType: state.bookType,
          width: state.width,
          height: state.height,
          spineWidth: state.spineWidth,
          pages: state.pages,
          coverFinish: state.coverFinish,
          paperColor: state.paperColor,
          pageEdgeStyle: state.pageEdgeStyle,
          customEdgeColor: state.customEdgeColor,
          preset: state.preset,
          lightIntensity: state.lightIntensity,
          lightRotation: state.lightRotation,
          shadowSoftness: state.shadowSoftness,
          dof: state.dof,
          fov: state.fov,
          showGrid: state.showGrid,
          exportBg: state.exportBg,
          exportScale: state.exportScale,
          coverImageSrc: state.coverImageSrc
        },
        objects: {}
      };
      
      // Save book group transform
      if (bookGroup) {
        data.objects.book = {
          px: bookGroup.position.x, py: bookGroup.position.y, pz: bookGroup.position.z,
          rx: bookGroup.rotation.x, ry: bookGroup.rotation.y, rz: bookGroup.rotation.z,
          s: bookGroup.scale.x, visible: bookGroup.visible,
          locked: !!bookGroup.userData.locked
        };
      }
      
      // Save prop transforms
      loadedProps.forEach(p => {
        data.objects[p.name.toLowerCase()] = {
          px: p.group.position.x, py: p.group.position.y, pz: p.group.position.z,
          rx: p.group.rotation.x, ry: p.group.rotation.y, rz: p.group.rotation.z,
          s: p.group.scale.x, visible: p.group.visible,
          locked: !!p.group.userData.locked
        };
      });
      
      const jsonStr = JSON.stringify(data, null, 2);
      const blob = new Blob([jsonStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      
      const link = document.createElement('a');
      link.download = `BookStudio3D_Config_${Date.now()}.json`;
      link.href = url;
      link.click();
      
      URL.revokeObjectURL(url);
      showToast('📤 Scene config exported successfully!');
    } catch (err) {
      console.error(err);
      showToast('❌ Failed to export config.');
    }
  }

  function importConfig(data) {
    if (!data || !data.state) {
      showToast('❌ Invalid config file.');
      return;
    }
    
    spinner.classList.remove('hidden');
    showToast('📥 Importing scene config...');
    
    setTimeout(() => {
      try {
        // 1. Restore state
        Object.assign(state, data.state);
        
        // 2. Sync UI sliders/inputs
        document.querySelectorAll('input[name="book-type"]').forEach(r => {
          r.checked = r.value === state.bookType;
        });
        document.getElementById('input-width').value = state.width;
        document.getElementById('input-height').value = state.height;
        document.getElementById('input-spine').value = state.spineWidth;
        document.getElementById('spine-val').textContent = state.spineWidth.toFixed(3) + '"';
        document.getElementById('input-pages').value = state.pages;
        document.getElementById('pages-val').textContent = state.pages;
        document.getElementById('select-finish').value = state.coverFinish;
        document.getElementById('select-paper').value = state.paperColor;
        document.querySelectorAll('.edge-dot').forEach(d => {
          d.classList.toggle('active', d.dataset.edge === state.pageEdgeStyle);
          d.style.border = d.dataset.edge === state.pageEdgeStyle ? '2px solid #7c3aed' : '';
        });
        document.getElementById('input-edge-color').value = state.customEdgeColor;
        document.getElementById('input-light-intensity').value = state.lightIntensity;
        document.getElementById('intensity-val').textContent = state.lightIntensity.toFixed(1) + 'x';
        document.getElementById('input-light-rotation').value = state.lightRotation;
        document.getElementById('rotation-val').textContent = state.lightRotation + '°';
        document.getElementById('input-shadow-softness').value = state.shadowSoftness;
        const ss = state.shadowSoftness;
        const ssText = ss < 0.2 ? 'Ultra Sharp' : ss < 0.4 ? 'Sharp' : ss > 1.0 ? 'Very Soft' : ss > 0.7 ? 'Soft' : 'Medium';
        document.getElementById('shadow-val').textContent = ssText;
        document.getElementById('input-fov').value = state.fov;
        const fovTxt = state.fov < 30 ? `${state.fov}° (Telephoto)` : state.fov > 55 ? `${state.fov}° (Wide Angle)` : `${state.fov}° (Portrait)`;
        document.getElementById('fov-val').textContent = fovTxt;
        if (camera) { camera.fov = state.fov; camera.updateProjectionMatrix(); }
        const dofEl = document.getElementById('input-dof');
        if (dofEl) { dofEl.value = state.dof; document.getElementById('dof-val').textContent = state.dof > 0 ? state.dof + '%' : 'Off'; }
        document.getElementById('select-export-bg').value = state.exportBg;
        document.getElementById('select-export-scale').value = String(state.exportScale);
        document.querySelectorAll('.preset-card').forEach(c => {
          c.classList.toggle('active', c.dataset.preset === state.preset);
        });
        const tgBtn = document.getElementById('toggle-grid-btn');
        if (tgBtn) tgBtn.classList.toggle('active', !!state.showGrid);
        if (gridHelper) gridHelper.visible = state.showGrid;
        if (window._axesHelper) window._axesHelper.visible = state.showGrid;
        
        // 3. Rebuild preset environment
        applyPreset();
        
        // 4. Load cover image if saved
        if (data.state.coverImageSrc) {
          loadCoverImage(data.state.coverImageSrc);
        } else {
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
          document.getElementById('cover-preview-img').src = '';
          document.getElementById('cover-preview-wrapper').classList.add('hidden');
          document.getElementById('drop-zone').classList.remove('hidden');
          document.getElementById('cover-upload').value = '';
          rebuildBook();
        }
        
        // 5. Restore object transforms
        applySavedTransforms(data);
        
        // 6. Save configuration to localStorage so it persists
        saveSettings();
        
        spinner.classList.add('hidden');
        showToast('🎉 Scene config imported successfully!');
      } catch (err) {
        console.error(err);
        spinner.classList.add('hidden');
        showToast('❌ Error applying scene config data.');
      }
    }, 100);
  }

  // Bind config buttons click events
  if (exportConfigBtn) {
    exportConfigBtn.addEventListener('click', () => {
      exportConfig();
    });
  }
  
  if (importConfigBtn) {
    importConfigBtn.addEventListener('click', () => {
      importConfigFile.click();
    });
  }
  
  if (importConfigFile) {
    importConfigFile.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      
      const reader = new FileReader();
      reader.onload = (event) => {
        try {
          const json = JSON.parse(event.target.result);
          importConfig(json);
        } catch (err) {
          console.error(err);
          showToast('❌ Failed to parse config JSON file.');
        }
      };
      reader.readAsText(file);
      importConfigFile.value = ''; // Reset input
    });
  }

  // Toast notifier
  function showToast(msg) {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.innerText = msg;
    toast.classList.add('show');
    if (toast.timeoutId) clearTimeout(toast.timeoutId);
    toast.timeoutId = setTimeout(() => { toast.classList.remove('show'); }, 3500);
  }

  // On startup: load the saved cover image or auto-load the default demo cover
  if (state.coverImageSrc) {
    loadCoverImage(state.coverImageSrc);
  } else {
    loadCoverImage('agi-question.png');
  }
});
