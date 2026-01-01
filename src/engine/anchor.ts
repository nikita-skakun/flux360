import type { Cov2, DevicePoint, Vec2 } from "@/ui/types";
import { addCov, invertCov, mulCovVec, mulMatMat, symmetric } from "./cov_utils";

export class Anchor {
  mean: Vec2;
  cov: Cov2;
  startTimestamp: number;
  supportCount: number;

  constructor(mean: Vec2, cov: Cov2, startTimestamp: number, supportCount: number = 1) {
    this.mean = [mean[0], mean[1]];
    this.cov = symmetric(cov);
    this.startTimestamp = startTimestamp;
    this.supportCount = supportCount;
  }

  clone(): Anchor {
    return new Anchor([this.mean[0], this.mean[1]], [this.cov[0], this.cov[1], this.cov[2]], this.startTimestamp, this.supportCount);
  }

  mahalanobis2(m: DevicePoint): number {
    const r: Vec2 = [m.mean[0] - this.mean[0], m.mean[1] - this.mean[1]];
    const S = addCov(this.cov, m.cov);
    const Si = invertCov(S);
    const Si_r = mulCovVec(Si, r);
    return r[0] * Si_r[0] + r[1] * Si_r[1];
  }

  kalmanUpdate(m: DevicePoint): void {
    const P = this.cov;
    const R = m.cov;
    const S = addCov(P, R);
    const Si = invertCov(S);

    const K = mulMatMat(P, Si);

    const r: Vec2 = [m.mean[0] - this.mean[0], m.mean[1] - this.mean[1]];
    const delta = mulCovVec(K, r);
    this.mean = [this.mean[0] + delta[0], this.mean[1] + delta[1]];

    const IminusK = [1 - K[0], -K[1], 1 - K[2]] as Cov2;

    const APA = mulMatMat(mulMatMat(IminusK, P), IminusK);
    const K_R = mulMatMat(K, R);
    const KRKT = mulMatMat(K_R, K);

    const newP = addCov(APA, KRKT);
    this.cov = symmetric(newP);
  }
}