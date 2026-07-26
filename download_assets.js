const fs = require('fs');
const path = require('path');
const https = require('https');

const assets = [
  {
    url: 'https://raw.githubusercontent.com/decentraland/smart-wearable-sample/main/glasses.glb',
    name: 'glasses.glb'
  },
  {
    url: 'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/Avocado/glTF-Binary/Avocado.glb',
    name: 'avocado.glb'
  },
  {
    url: 'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/WaterBottle/glTF-Binary/WaterBottle.glb',
    name: 'water_bottle.glb'
  },
  {
    url: 'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/AntiqueCamera/glTF-Binary/AntiqueCamera.glb',
    name: 'antique_camera.glb'
  }
];

const publicDir = path.join(__dirname, 'public');

if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir, { recursive: true });
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`Failed to get '${url}' (Status Code: ${response.statusCode})`));
        return;
      }
      response.pipe(file);
      file.on('finish', () => {
        file.close(resolve);
      });
    }).on('error', (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

async function main() {
  console.log('Downloading 3D models...');
  for (const asset of assets) {
    const dest = path.join(publicDir, asset.name);
    console.log(`Downloading ${asset.name} from ${asset.url}...`);
    try {
      await download(asset.url, dest);
      console.log(`Successfully downloaded ${asset.name}`);
    } catch (err) {
      console.error(`Error downloading ${asset.name}:`, err.message);
    }
  }
  console.log('All downloads finished.');
}

main();
