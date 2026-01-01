import type { Cov2, DevicePoint, Vec2 } from "@/ui/types";

function addCov(a: Cov2, b: Cov2): Cov2 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function mulCovScalar(a: Cov2, s: number): Cov2 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

function detCov(a: Cov2): number {
  return a[0] * a[2] - a[1] * a[1];
}

function invertCov(a: Cov2): Cov2 {
  const d = detCov(a);
  if (!isFinite(d) || Math.abs(d) < 1e-12) {
    return [1e12, 0, 1e12];
  }
  const inv = 1 / d;
  return [a[2] * inv, -a[1] * inv, a[0] * inv];
}

function mulCovVec(a: Cov2, v: Vec2): Vec2 {
  const [a00, a01, a11] = a;
  return [a00 * v[0] + a01 * v[1], a01 * v[0] + a11 * v[1]];
}

function mulMatMat(a: Cov2, b: Cov2): Cov2 {
  const a00 = a[0];
  const a01 = a[1];
  const a11 = a[2];
  const b00 = b[0];
  const b01 = b[1];
  const b11 = b[2];
  const r00 = a00 * b00 + a01 * b01;
  const r01 = a00 * b01 + a01 * b11;
  const r11 = a01 * b01 + a11 * b11;
  return [r00, r01, r11];
}

function symmetric(c: Cov2): Cov2 {
  return [c[0], (c[1] + c[1]) / 2, c[2]];
}

export class Component {
  mean: Vec2;
  cov: Cov2;
  consistency: number;
  spawnedDuringMovement: boolean;
  createdAt: number;

  constructor(mean: Vec2, cov: Cov2, consistency = 0.9) {
    this.mean = [mean[0], mean[1]];
    this.cov = symmetric(cov);
    this.consistency = Math.max(0, Math.min(1, consistency));
    this.spawnedDuringMovement = false;
    this.createdAt = Date.now();
  }

  clone(): Component {
    const c = new Component([this.mean[0], this.mean[1]], [this.cov[0], this.cov[1], this.cov[2]], this.consistency);
    c.spawnedDuringMovement = this.spawnedDuringMovement;
    c.createdAt = this.createdAt;
    return c;
  }

  mahalanobis2(m: DevicePoint): number {
    const r: Vec2 = [m.mean[0] - this.mean[0], m.mean[1] - this.mean[1]];
    const S = addCov(this.cov, m.cov);
    const Si = invertCov(S);
    const Si_r = mulCovVec(Si, r);
    return r[0] * Si_r[0] + r[1] * Si_r[1];
  }

  logLikelihood(m: DevicePoint): number {
    const d2 = this.mahalanobis2(m);
    const S = addCov(this.cov, m.cov);
    const determinant = Math.max(1e-12, detCov(S));
    return -0.5 * d2 - 0.5 * Math.log(determinant);
  }

  kalmanUpdate(m: DevicePoint, gainScale = 1): void {
    const P = this.cov;
    const R = m.cov;
    const S = addCov(P, R);
    const Si = invertCov(S);

    const K = mulMatMat(P, Si);
    const Kscaled: Cov2 = mulCovScalar(K, gainScale);

    const r: Vec2 = [m.mean[0] - this.mean[0], m.mean[1] - this.mean[1]];
    const delta = mulCovVec(Kscaled, r);
    this.mean = [this.mean[0] + delta[0], this.mean[1] + delta[1]];

    const IminusK = [1 - Kscaled[0], -Kscaled[1], 1 - Kscaled[2]] as Cov2;

    const APA = mulMatMat(mulMatMat(IminusK, P), IminusK);
    const K_R = mulMatMat(Kscaled, R);
    const KRKT = mulMatMat(K_R, Kscaled);

    const newP = addCov(APA, KRKT);
    this.cov = symmetric(newP);
  }
}
