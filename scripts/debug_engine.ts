import fs from 'fs/promises';
import path from 'path';
import MixtureEngine from '../src/engine/mixture';

async function main(){
  const p = path.join(process.cwd(), 'dev-data', 'positions.json');
  try{
    const txt = await fs.readFile(p,'utf8');
    const positions = JSON.parse(txt);
    const engine = new MixtureEngine();
    engine.reset();
    const refLat = positions[0].lat;
    const refLon = positions[0].lon;
    // function degreesToMeters from util
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
      engine.updateWithMeasurement({ mean: [x,y], cov, timestamp: p.timestamp });
    }
    const snaps = engine.timeline.asArray();
    for (let i=0; i<snaps.length; i++){
      const s = snaps[i];
      const means = s.data.components.map(c=>c.mean);
      console.log(`snapshot ${i} @ ${new Date(s.timestamp).toISOString()} comps=${means.length}`);
      for (const comp of s.data.components){
        console.log('  mean', comp.mean[0].toFixed(2), comp.mean[1].toFixed(2), 'cov', comp.cov[0].toFixed(2), comp.cov[2].toFixed(2), 'w', comp.weight.toFixed(4));
      }
    }
  }catch(e){
    console.error(e);
  }
}
main();
