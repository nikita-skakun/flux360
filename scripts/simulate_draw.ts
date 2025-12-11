import fs from 'fs/promises';
import path from 'path';
import MixtureEngine from '../src/engine/mixture';
import { eigenDecomposition } from '../src/engine/gaussian';

async function main(){
  const p = path.join(process.cwd(), 'dev-data', 'positions.json');
  try{
    const txt = await fs.readFile(p,'utf8');
    const positions = JSON.parse(txt);
    const engine = new MixtureEngine();
    engine.reset();
    const refLat = positions[0].lat;
    const refLon = positions[0].lon;
    const deg2m = (lat:number, lon:number, refLat=lat, refLon=lon) => {
      const R = 6371000;
      const dLat = (lat - refLat) * (Math.PI / 180);
      const dLon = (lon - refLon) * (Math.PI / 180);
      const meanLat = ((lat + refLat) / 2) * (Math.PI / 180);
      const x = dLon * R * Math.cos(meanLat);
      const y = dLat * R;
      return {x,y};
    }
    for (const p of positions){
      const {x,y} = deg2m(p.lat,p.lon, refLat, refLon);
      const cov = [p.accuracy*p.accuracy, 0, p.accuracy*p.accuracy];
      engine.predictAll();
      engine.updateWithMeasurement({ mean: [x,y], cov: cov as any, timestamp: p.timestamp });
    }
    const snaps = engine.timeline.asArray();
    // simulate CanvasView center/zoom calculation
    function computeCamera(components: any[], width=800, height=600, worldBounds?: any){
      let cx = width/2, cy = height/2;
      let localZoom = 1;
      if (components.length>0){
        let minX=1e9, maxX=-1e9, minY=1e9, maxY=-1e9;
        for (const c of components){
          minX = Math.min(minX, c.mean[0]); maxX = Math.max(maxX, c.mean[0]);
          minY = Math.min(minY, c.mean[1]); maxY = Math.max(maxY, c.mean[1]);
        }
        if (worldBounds) {
          minX = Math.min(minX, worldBounds.minX);
          maxX = Math.max(maxX, worldBounds.maxX);
          minY = Math.min(minY, worldBounds.minY);
          maxY = Math.max(maxY, worldBounds.maxY);
        }
        const widthMeters = Math.max(1, maxX - minX);
        const heightMeters = Math.max(1, maxY - minY);
        const pad = 0.86;
        const minWorldWidth = Math.max(widthMeters, heightMeters);
        //console.log('widthMeters', widthMeters, 'heightMeters', heightMeters, 'minWorldWidth', minWorldWidth);
        localZoom = Math.min(width * pad / minWorldWidth, height * pad / minWorldWidth);
        const centerX=(minX + maxX)/2, centerY=(minY+maxY)/2;
        const anchorX = 0;
        const anchorY = 0;
        cx = width/2;
        cy = height/2;
      }
      return {cx, cy, localZoom};
    }

    for (let i=0;i<snaps.length;i++){
      const s = snaps[i]!;
      // compute world bounds across all snapshots
      let wMinX = Infinity, wMaxX = -Infinity, wMinY = Infinity, wMaxY = -Infinity;
      for (const s of snaps) {
        for (const c of s!.data.components) {
        wMinX = Math.min(wMinX, c.mean[0]);
        wMaxX = Math.max(wMaxX, c.mean[0]);
        wMinY = Math.min(wMinY, c.mean[1]);
        wMaxY = Math.max(wMaxY, c.mean[1]);
        }
      }
      const world = { minX: wMinX, minY: wMinY, maxX: wMaxX, maxY: wMaxY };
      const comps = s.data.components;
      const cam = computeCamera(comps, 800,600, world);
      console.log(`snap ${i} zoom ${cam.localZoom.toFixed(3)} cx ${cam.cx.toFixed(2)} cy ${cam.cy.toFixed(2)}`)
      for (const c of comps){
        const x = cam.cx + (c.mean[0] - 0) * cam.localZoom;
        const y = cam.cy - (c.mean[1] - 0) * cam.localZoom;
        const { lambda1, lambda2 } = eigenDecomposition(c.cov as any);
        console.log(`  comp mean meters ${c.mean[0].toFixed(2)},${c.mean[1].toFixed(2)} px ${x.toFixed(1)},${y.toFixed(1)} radii px ${Math.sqrt(lambda1)*cam.localZoom | 0},${Math.sqrt(lambda2)*cam.localZoom |0}`)
      }
    }
  }catch(e){console.error(e)}
}
main();
