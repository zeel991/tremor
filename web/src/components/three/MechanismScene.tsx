"use client";

import { useMemo, useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import * as THREE from "three";

export type MechanismKind = "write" | "buy" | "settle" | "hedge";

const LIME = "#BAFE4E";
const LIME_DARK = "#648F20";
const INK = "#171819";
const MID = "#8B9095";
const LIGHT = "#D9DCDE";
const PAPER = "#F7F7F5";

type V3 = [number, number, number];

function Box({ size, position, color, opacity = 1 }: { size: V3; position: V3; color: string; opacity?: number }) {
  return (
    <mesh position={position} castShadow receiveShadow>
      <boxGeometry args={size} />
      <meshStandardMaterial color={color} roughness={0.72} metalness={0.02} transparent={opacity < 1} opacity={opacity} />
    </mesh>
  );
}

function Puck({ position, color = LIME, scale = 1 }: { position: V3; color?: string; scale?: number }) {
  return (
    <mesh position={position} castShadow rotation={[0, 0, Math.PI / 2]} scale={scale}>
      <cylinderGeometry args={[0.24, 0.24, 0.13, 24]} />
      <meshStandardMaterial color={color} roughness={0.55} />
    </mesh>
  );
}

function Tube({ points, color, radius = 0.045 }: { points: V3[]; color: string; radius?: number }) {
  const geometry = useMemo(() => {
    const curve = new THREE.CatmullRomCurve3(points.map((point) => new THREE.Vector3(...point)), false, "catmullrom", 0.08);
    return new THREE.TubeGeometry(curve, 72, radius, 10, false);
  }, [points, radius]);
  return (
    <mesh geometry={geometry} castShadow>
      <meshStandardMaterial color={color} roughness={0.6} />
    </mesh>
  );
}

function StreamPuck({ path, phase, active, color = LIME, speed = 0.12, scale = 1 }: { path: V3[]; phase: number; active: boolean; color?: string; speed?: number; scale?: number }) {
  const ref = useRef<THREE.Mesh>(null);
  const material = useRef<THREE.MeshStandardMaterial>(null);
  const curve = useMemo(() => new THREE.CatmullRomCurve3(path.map((point) => new THREE.Vector3(...point)), false, "catmullrom", 0.08), [path]);
  useFrame(({ clock }) => {
    if (!ref.current || !material.current || !active) return;
    const u = (clock.elapsedTime * speed + phase) % 1;
    const visibility = Math.min(1, u / 0.09, (1 - u) / 0.16);
    ref.current.position.copy(curve.getPointAt(u));
    ref.current.scale.setScalar(scale * (0.72 + visibility * 0.28));
    material.current.opacity = Math.max(0, visibility);
  });
  return (
    <mesh ref={ref} position={path[0]} castShadow rotation={[0, 0, Math.PI / 2]}>
      <cylinderGeometry args={[0.15, 0.15, 0.09, 20]} />
      <meshStandardMaterial ref={material} color={color} roughness={0.5} transparent opacity={0} />
    </mesh>
  );
}

function FlowTube({ points, color, pulseColor, radius, active, speed = 0.16 }: { points: V3[]; color: string; pulseColor: string; radius: number; active: boolean; speed?: number }) {
  const material = useRef<THREE.ShaderMaterial>(null);
  const geometry = useMemo(() => {
    const curve = new THREE.CatmullRomCurve3(points.map((point) => new THREE.Vector3(...point)), false, "catmullrom", 0.08);
    return new THREE.TubeGeometry(curve, 96, radius, 12, false);
  }, [points, radius]);
  const uniforms = useMemo(() => ({
      uTime: { value: 0 },
      uBase: { value: new THREE.Color(color) },
      uPulse: { value: new THREE.Color(pulseColor) },
  }), [color, pulseColor]);
  const vertexShader = `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `;
  const fragmentShader = `
      uniform float uTime;
      uniform vec3 uBase;
      uniform vec3 uPulse;
      varying vec2 vUv;
      void main() {
        float head = fract(uTime);
        float distanceToHead = abs(vUv.x - head);
        distanceToHead = min(distanceToHead, 1.0 - distanceToHead);
        float glow = smoothstep(0.16, 0.0, distanceToHead);
        glow *= smoothstep(0.0, 0.08, vUv.x) * smoothstep(1.0, 0.9, vUv.x);
        gl_FragColor = vec4(mix(uBase, uPulse, glow), 1.0);
      }
    `;
  useFrame(({ clock }) => {
    if (active && material.current) material.current.uniforms.uTime.value = clock.elapsedTime * speed;
  });
  return (
    <mesh geometry={geometry} castShadow>
      <shaderMaterial ref={material} uniforms={uniforms} vertexShader={vertexShader} fragmentShader={fragmentShader} />
    </mesh>
  );
}

function FillBeacon({ position, phase, active }: { position: V3; phase: number; active: boolean }) {
  const ref = useRef<THREE.Mesh>(null);
  const material = useRef<THREE.MeshBasicMaterial>(null);
  useFrame(({ clock }) => {
    if (!ref.current || !material.current || !active) return;
    const pulse = (Math.sin(clock.elapsedTime * 2.1 + phase) + 1) / 2;
    ref.current.scale.setScalar(0.82 + pulse * 0.34);
    material.current.opacity = 0.22 + pulse * 0.42;
    ref.current.rotation.z = clock.elapsedTime * 0.35;
  });
  return (
    <mesh ref={ref} position={position} rotation={[Math.PI / 2, 0, 0]}>
      <torusGeometry args={[0.28, 0.035, 10, 30]} />
      <meshBasicMaterial ref={material} color={LIME} transparent opacity={0.4} depthWrite={false} />
    </mesh>
  );
}

function Base({ width = 8.4, depth = 4.2 }: { width?: number; depth?: number }) {
  return (
    <mesh position={[0, -0.08, 0]} receiveShadow>
      <boxGeometry args={[width, 0.12, depth]} />
      <meshStandardMaterial color={PAPER} roughness={1} />
    </mesh>
  );
}

function WriteScene({ active }: { active: boolean }) {
  const premiumPath = useMemo<V3[]>(() => [[-1.42, 0.66, -0.74], [0.15, 0.66, -0.74], [1.92, 0.66, -0.74]], []);
  const settlementPath = useMemo<V3[]>(() => [[-1.42, 0.66, 0.74], [0.15, 0.66, 0.74], [1.92, 0.66, 0.74]], []);
  return (
    <group position={[0, 0.05, 0]}>
      <Base />
      <Box size={[2.15, 0.16, 2.35]} position={[-2.65, 0.08, 0]} color={INK} />
      <Box size={[0.13, 1.05, 2.35]} position={[-3.66, 0.58, 0]} color={INK} />
      <Box size={[2.15, 1.05, 0.13]} position={[-2.65, 0.58, -1.11]} color={INK} />
      <Box size={[2.15, 1.05, 0.13]} position={[-2.65, 0.58, 1.11]} color={INK} />
      {[-0.45, 0, 0.45].map((z, index) => <Puck key={z} position={[-2.72 + index * 0.16, 0.34, z]} scale={1.05} />)}
      <Box size={[4.4, 0.08, 0.34]} position={[0.45, 0.52, -0.74]} color={MID} />
      <Box size={[4.4, 0.08, 0.34]} position={[0.45, 0.52, 0.74]} color={MID} />
      {[0, 0.34, 0.68].map((phase) => <StreamPuck key={`premium-${phase}`} path={premiumPath} phase={phase} active={active} />)}
      {[0.16, 0.5, 0.84].map((phase) => <StreamPuck key={`settlement-${phase}`} path={settlementPath} phase={phase} active={active} color={LIGHT} />)}
      <mesh position={[2.88, 0.77, 0]} castShadow rotation={[0, Math.PI / 4, 0]}>
        <octahedronGeometry args={[0.72, 0]} />
        <meshStandardMaterial color={LIME} roughness={0.55} />
      </mesh>
      <mesh position={[2.88, 0.77, 0]} rotation={[0, Math.PI / 4, 0]}>
        <octahedronGeometry args={[0.86, 0]} />
        <meshBasicMaterial color={LIME} wireframe transparent opacity={0.45} />
      </mesh>
    </group>
  );
}

const BUY_CURVE: V3[] = [[-3.8, 0.25, 0], [-2.8, 0.25, 0], [-2.7, 1.55, 0], [-2.15, 1.18, 0], [-1.35, 0.72, 0], [-1.22, 1.92, 0], [-0.5, 1.38, 0], [0.35, 0.78, 0], [1.25, 0.43, 0], [2.35, 0.29, 0], [3.7, 0.25, 0]];

function BuyScene({ active }: { active: boolean }) {
  return (
    <group position={[0, -0.34, 0]} rotation={[0, -0.08, 0]}>
      <Base depth={3.8} />
      {[-3, -2, -1, 0, 1, 2, 3].map((x) => <Box key={x} size={[0.018, 0.02, 3.35]} position={[x, 0.02, 0]} color={LIGHT} />)}
      {[0.65, 1.25, 1.85].map((y) => <Box key={y} size={[7.7, 0.018, 0.025]} position={[0, y, 0]} color={LIGHT} />)}
      <FlowTube points={BUY_CURVE} color={LIME_DARK} pulseColor={LIME} radius={0.085} active={active} speed={0.2} />
      <Box size={[0.08, 1.55, 0.6]} position={[-2.7, 0.78, 0]} color={LIME} opacity={0.52} />
      <Box size={[0.08, 1.92, 0.6]} position={[-1.22, 0.96, 0]} color={LIME} opacity={0.52} />
      <Puck position={[-2.7, 1.66, 0]} scale={0.78} />
      <Puck position={[-1.22, 2.03, 0]} scale={0.78} />
      <FillBeacon position={[-2.7, 1.66, 0]} phase={0} active={active} />
      <FillBeacon position={[-1.22, 2.03, 0]} phase={1.4} active={active} />
    </group>
  );
}

function SettleScene({ active }: { active: boolean }) {
  const heights = [0.5, 1.05, 0.72, 1.4, 0.82];
  const pricePoints = heights.map((height, index) => [-3.7 + index * 0.62, height + 0.12, -0.45] as V3);
  const inputPath = useMemo<V3[]>(() => [[-1.65, 0.5, -0.2], [-1.2, 0.55, -0.14], [-0.82, 0.62, -0.08]], []);
  const outputPath = useMemo<V3[]>(() => [[0.82, 0.58, 0], [1.65, 0.58, 0], [2.5, 0.58, 0]], []);
  return (
    <group position={[0, -0.32, 0]}>
      <Base />
      {heights.map((height, index) => (
        <group key={index}>
          <Box size={[0.13, height, 0.13]} position={[-3.7 + index * 0.62, height / 2, -0.45]} color={index === 3 ? LIME : MID} />
          <Puck position={[-3.7 + index * 0.62, height + 0.12, -0.45]} color={index === 3 ? LIME : LIGHT} scale={0.55} />
        </group>
      ))}
      <Tube points={pricePoints} color={INK} radius={0.035} />
      {[0, 0.33, 0.66].map((phase) => <StreamPuck key={`oracle-${phase}`} path={pricePoints} phase={phase} active={active} color={LIGHT} speed={0.1} scale={0.62} />)}
      <Box size={[1.35, 1.35, 1.35]} position={[0, 0.72, 0]} color={INK} />
      <mesh position={[0, 0.72, 0]} rotation={[0, Math.PI / 4, 0]}>
        <torusGeometry args={[0.42, 0.07, 10, 34]} />
        <meshStandardMaterial color={LIME} roughness={0.5} />
      </mesh>
      {[0.1, 0.6].map((phase) => <StreamPuck key={`input-${phase}`} path={inputPath} phase={phase} active={active} color={LIGHT} speed={0.14} scale={0.8} />)}
      <Box size={[2.35, 0.12, 0.62]} position={[1.92, 0.42, 0]} color={MID} />
      {[0.05, 0.38, 0.71].map((phase) => <StreamPuck key={`output-${phase}`} path={outputPath} phase={phase} active={active} speed={0.16} />)}
      <Box size={[1.0, 1.45, 1.25]} position={[3.25, 0.72, 0]} color={LIME} />
      <Box size={[1.34, 0.12, 1.55]} position={[3.25, 1.5, 0]} color={INK} />
      <Puck position={[3.25, 0.72, 0]} color={INK} scale={1.15} />
    </group>
  );
}

function HedgeScene({ active }: { active: boolean }) {
  const beam = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    if (!beam.current || !active) return;
    beam.current.rotation.z = -0.025 + Math.sin(clock.elapsedTime * 0.72) * 0.035;
  });
  return (
    <group position={[0, -0.22, 0]} rotation={[0, -0.08, 0]} scale={0.88}>
      <Base />
      <mesh position={[0, 0.56, 0]} castShadow>
        <cylinderGeometry args={[0.08, 0.72, 1.05, 3]} />
        <meshStandardMaterial color={MID} roughness={0.72} />
      </mesh>
      <group ref={beam} position={[0, 1.16, 0]} rotation={[0, 0, -0.025]}>
        <Box size={[6.15, 0.14, 0.34]} position={[0, 0, 0]} color={INK} />
        <Box size={[1.72, 0.12, 1.38]} position={[-2.38, 0.13, 0]} color={INK} />
        <Box size={[1.72, 0.12, 1.38]} position={[2.38, 0.13, 0]} color={LIGHT} />
        <Box size={[0.62, 0.55, 0.62]} position={[-2.68, 0.46, -0.28]} color={INK} />
        <Box size={[0.62, 0.82, 0.62]} position={[-2.08, 0.59, 0.24]} color={INK} />
        {[0, 0.18, 0.36].map((y) => (
          <mesh key={`receipt-left-${y}`} position={[2.08, 0.27 + y, -0.28]} castShadow>
            <cylinderGeometry args={[0.31, 0.31, 0.14, 24]} />
            <meshStandardMaterial color={LIME} roughness={0.52} />
          </mesh>
        ))}
        {[0, 0.18].map((y) => (
          <mesh key={`receipt-right-${y}`} position={[2.68, 0.27 + y, 0.28]} castShadow>
            <cylinderGeometry args={[0.31, 0.31, 0.14, 24]} />
            <meshStandardMaterial color={LIME} roughness={0.52} />
          </mesh>
        ))}
        <Box size={[1.48, 0.09, 1.18]} position={[2.45, 0.98, 0]} color={INK} />
        <Box size={[0.06, 0.72, 0.06]} position={[1.52, 0.61, -0.66]} color={MID} />
        <Box size={[0.06, 0.72, 0.06]} position={[3.24, 0.61, 0.66]} color={MID} />
      </group>
    </group>
  );
}

function Scene({ kind, active }: { kind: MechanismKind; active: boolean }) {
  const root = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    if (!root.current || !active) return;
    root.current.rotation.y = Math.sin(clock.elapsedTime * 0.18) * 0.055;
  });
  return (
    <group ref={root} rotation={[0, -0.03, 0]}>
      {kind === "write" ? <WriteScene active={active} /> : kind === "buy" ? <BuyScene active={active} /> : kind === "settle" ? <SettleScene active={active} /> : <HedgeScene active={active} />}
    </group>
  );
}

export default function MechanismScene({ kind, active, frozen }: { kind: MechanismKind; active: boolean; frozen: boolean }) {
  const animate = active && !frozen;
  return (
    <Canvas
      frameloop={animate ? "always" : "demand"}
      orthographic
      camera={{ position: [6.2, 4.8, 7.8], zoom: 45, near: 0.1, far: 60 }}
      dpr={[1, 1.25]}
      shadows={{ type: THREE.PCFShadowMap }}
      gl={{ alpha: true, antialias: true, powerPreference: "high-performance" }}
      style={{ background: "transparent" }}
      aria-hidden="true"
    >
      <hemisphereLight args={["#ffffff", "#A4A7AA", 1.2]} />
      <directionalLight position={[-4, 7, 6]} intensity={2.2} castShadow shadow-mapSize={[256, 256]} />
      <directionalLight position={[5, 3, -4]} intensity={0.65} />
      <Scene kind={kind} active={animate} />
    </Canvas>
  );
}
