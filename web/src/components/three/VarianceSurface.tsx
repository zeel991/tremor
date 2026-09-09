"use client";

/* eslint-disable react-hooks/immutability -- frame animation intentionally updates Three.js buffers. */

import { useMemo, useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import * as THREE from "three";

const LIME = "#BAFE4E";
const WIDTH = 24;
const DEPTH = 20;
const SEGMENTS_X = 88;
const SEGMENTS_Y = 72;
const VALLEY = new THREE.Color("#2E5A00");
const MID = new THREE.Color("#7FBF2E");
const PEAK = new THREE.Color(LIME);
const CAM = new THREE.Vector3(2.4, 1.6, 5.2);
const LOOK = new THREE.Vector3(-0.8, -0.4, 0);

/**
 * Low-poly matte lime terrain. Its oversized 24×20 plane remains beyond the camera frustum during
 * drift, so the hero never reveals an outer edge or corner. Amplitude follows live realized vol.
 */
function Surface({ vol, frozen }: { vol: number; frozen: boolean }) {
  const mesh = useRef<THREE.Mesh>(null);
  const geometry = useMemo(() => {
    const g = new THREE.PlaneGeometry(WIDTH, DEPTH, SEGMENTS_X, SEGMENTS_Y);
    g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 3), 3));
    return g;
  }, []);
  const base = useMemo(() => Float32Array.from(geometry.attributes.position.array), [geometry]);
  const t = useRef(0);
  const target = useRef(vol);
  const tmp = useMemo(() => new THREE.Color(), []);

  useFrame((_, delta) => {
    if (!mesh.current) return;
    if (!frozen) t.current += Math.min(delta, 0.05);
    target.current += (vol - target.current) * 0.02;
    const amp = 0.6 + 2.2 * Math.min(1.2, Math.max(0, target.current));
    const pos = geometry.attributes.position as THREE.BufferAttribute;
    const col = geometry.attributes.color as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    const carr = col.array as Float32Array;
    const time = t.current;
    for (let i = 0; i < arr.length; i += 3) {
      const x = base[i];
      const y = base[i + 1];
      const h =
        0.5 * Math.sin(x * 0.55 + time * 0.35) +
        0.32 * Math.sin(y * 0.8 - time * 0.27 + 1.3) +
        0.26 * Math.sin((x + y) * 0.42 + time * 0.2) +
        0.14 * Math.sin((x - y * 1.7) * 0.9 - time * 0.45) +
        0.09 * Math.sin(x * 0.55 * 1.6 - y * 0.6 + time * 0.5) +
        0.06 * Math.sin((x * 0.7 + y * 0.9) * 2.8 + time * 0.6);
      arr[i + 2] = amp * h;
      const u = Math.min(1, Math.max(0, (h + 1.2) / 2.4));
      if (u < 0.5) tmp.copy(VALLEY).lerp(MID, u * 2);
      else tmp.copy(MID).lerp(PEAK, (u - 0.5) * 2);
      carr[i] = tmp.r;
      carr[i + 1] = tmp.g;
      carr[i + 2] = tmp.b;
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    geometry.computeVertexNormals();
    mesh.current.parent!.rotation.z = Math.sin(time * 0.08) * 0.05;
  });

  return (
    <group position={[-1.2, -1.5, -0.6]} rotation={[-Math.PI / 2, 0, 0]}>
      <mesh ref={mesh} geometry={geometry}>
        <meshStandardMaterial vertexColors roughness={0.85} metalness={0} flatShading />
      </mesh>
      <mesh geometry={geometry}>
        <meshBasicMaterial color={LIME} wireframe transparent opacity={0.35} depthWrite={false} />
      </mesh>
    </group>
  );
}

function Drift({ frozen }: { frozen: boolean }) {
  const t = useRef(0);
  useFrame(({ camera }, delta) => {
    if (!frozen) t.current += Math.min(delta, 0.05);
    const time = t.current;
    camera.position.set(CAM.x + Math.sin(time * 0.09) * 0.35, CAM.y + Math.cos(time * 0.07) * 0.12, CAM.z + Math.sin(time * 0.05) * 0.25);
    camera.lookAt(LOOK);
  });
  return null;
}

/** Off-screen or hidden canvases retain their last frame without continually rendering. */
export default function VarianceSurface({ vol, active, frozen }: { vol: number; active: boolean; frozen: boolean }) {
  const frameloop = active && !frozen ? "always" : "demand";
  return (
    <Canvas
      frameloop={frameloop}
      dpr={[1, 1.5]}
      gl={{ alpha: true, antialias: true, powerPreference: "low-power", preserveDrawingBuffer: true }}
      camera={{ position: CAM.toArray(), fov: 38, near: 0.1, far: 60 }}
      style={{ background: "transparent" }}
      aria-hidden="true"
    >
      <hemisphereLight args={["#ffffff", "#5f6368", 0.35]} />
      <directionalLight position={[-6, 2.5, 4]} intensity={1.6} />
      <directionalLight position={[5, 4, -3]} intensity={0.25} />
      <Surface vol={vol} frozen={frozen} />
      <Drift frozen={frozen} />
    </Canvas>
  );
}
