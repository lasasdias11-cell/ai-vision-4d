// physics.js — PhysicsEngine: gravity, friction, bounce, angular decay.
// Operates on ObjectManager's object list; grabbed objects are skipped.

export const PHYSICS = Object.freeze({
  gravity: 0.55,          // units / s^2 applied to velocity.y
  friction: 0.10,         // per-second velocity retention factor base
  restitution: 0.48,      // bounce energy kept
  floorY: -3.0,           // ground plane
  wallX: 5.5,
  wallZNear: 2.5,
  wallZFar: -7.0,
  angularDecay: 0.35,     // per-second angular velocity retention base
  spinIdle: 0.22,         // idle rotation rad/s
});

export class PhysicsEngine {
  constructor(cfg = {}) {
    this.cfg = { ...PHYSICS, ...cfg };
  }

  // objects: array of Groups with userData {velocity:Vector3,
  // angularVelocity:Vector3, radius:number, grabbed:boolean}
  step(objects, dt) {
    const c = this.cfg;
    dt = Math.min(dt, 0.05);
    const friction = Math.pow(c.friction, dt);
    const angFriction = Math.pow(c.angularDecay, dt);

    for (const obj of objects) {
      const ud = obj.userData;
      if (!ud || ud.grabbed) continue;

      const v = ud.velocity;
      const av = ud.angularVelocity;
      const r = ud.radius ?? 0.5;

      v.y -= c.gravity * dt;
      obj.position.addScaledVector(v, dt);
      v.multiplyScalar(friction);

      // Floor bounce.
      if (obj.position.y < c.floorY + r) {
        obj.position.y = c.floorY + r;
        if (v.y < 0) v.y = Math.abs(v.y) * c.restitution;
        v.x *= 0.92;
        v.z *= 0.92;
      }
      // Soft walls.
      if (obj.position.x > c.wallX) { obj.position.x = c.wallX; v.x = -Math.abs(v.x) * 0.4; }
      if (obj.position.x < -c.wallX) { obj.position.x = -c.wallX; v.x = Math.abs(v.x) * 0.4; }
      if (obj.position.z > c.wallZNear) { obj.position.z = c.wallZNear; v.z = -Math.abs(v.z) * 0.4; }
      if (obj.position.z < c.wallZFar) { obj.position.z = c.wallZFar; v.z = Math.abs(v.z) * 0.4; }

      // Angular motion: userData.angularVelocity plus a gentle idle tumble.
      if (av) {
        obj.rotation.x += av.x * dt;
        obj.rotation.y += av.y * dt;
        obj.rotation.z += av.z * dt;
        av.multiplyScalar(angFriction);
      }
      obj.rotation.x += c.spinIdle * dt;
      obj.rotation.y += c.spinIdle * 1.27 * dt;
    }
  }
}
