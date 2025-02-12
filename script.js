import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

// ================================
// Scene, Camera, Renderer, and Controls Setup
// ================================
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x202020);

const camera = new THREE.PerspectiveCamera(
  75,
  window.innerWidth / window.innerHeight,
  0.1,
  1000
);
// Position the camera to view the whole scene.
camera.position.set(0, 15, -30);
camera.lookAt(new THREE.Vector3(0, 5, 5));

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
// Enable shadows in the renderer.
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);

// ================================
// Lighting
// ================================
const ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
scene.add(ambientLight);

const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
directionalLight.position.set(10, 20, -10);
directionalLight.castShadow = true;
// Configure shadow properties for better quality.
directionalLight.shadow.mapSize.width = 1024;
directionalLight.shadow.mapSize.height = 1024;
directionalLight.shadow.camera.near = 0.5;
directionalLight.shadow.camera.far = 50;
directionalLight.shadow.camera.left = -20;
directionalLight.shadow.camera.right = 20;
directionalLight.shadow.camera.top = 20;
directionalLight.shadow.camera.bottom = -20;
scene.add(directionalLight);

// ================================
// Create Multiple White Planes
// ================================
// Define each plane by a point, a normal, and dimensions.
const planesData = [
  // Ground plane.
  { 
    point: new THREE.Vector3(0, 0, 0),
    normal: new THREE.Vector3(0, 1, 0),
    width: 200,
    height: 200,
    color: 0xffffff
  },
  // Left wall.
  { 
    point: new THREE.Vector3(-15, 10, 5),
    normal: new THREE.Vector3(1, 0, 0),
    width: 30,
    height: 20,
    color: 0xffffff
  },
  // Right wall.
  { 
    point: new THREE.Vector3(15, 10, 5),
    normal: new THREE.Vector3(-1, 0, 0),
    width: 30,
    height: 20,
    color: 0xffffff
  },
  // Back wall.
  { 
    point: new THREE.Vector3(0, 10, 25),
    normal: new THREE.Vector3(0, 0, -1),
    width: 30,
    height: 20,
    color: 0xffffff
  }
];

planesData.forEach(data => {
  const geometry = new THREE.PlaneGeometry(data.width, data.height);
  const material = new THREE.MeshPhongMaterial({
    color: data.color,
    side: THREE.DoubleSide
  });
  const planeMesh = new THREE.Mesh(geometry, material);
  // By default, PlaneGeometry’s normal is along +Z.
  const defaultNormal = new THREE.Vector3(0, 0, 1);
  const quaternion = new THREE.Quaternion().setFromUnitVectors(
    defaultNormal,
    data.normal.clone().normalize()
  );
  planeMesh.quaternion.copy(quaternion);
  planeMesh.position.copy(data.point);
  planeMesh.receiveShadow = true;
  scene.add(planeMesh);
  // Tag the data for intersection tests.
  data.type = 'plane';
});

// ================================
// Create Levitate Spheres (Balls)
// ================================
// Adjust the spheres to be higher in the air.
const spheresData = [
  { center: new THREE.Vector3(0, 8, 5),  radius: 1.0, color: 0xff6464 },
  { center: new THREE.Vector3(3, 10, 8), radius: 1.5, color: 0x64ff64 },
  { center: new THREE.Vector3(-3, 9, 10), radius: 2.0, color: 0x6464ff }
];

spheresData.forEach(sphere => {
  const geometry = new THREE.SphereGeometry(sphere.radius, 32, 32);
  const material = new THREE.MeshPhongMaterial({
    color: sphere.color,
    shininess: 100,
    transparent: true,
    opacity: 0.9,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.copy(sphere.center);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);
  sphere.type = 'sphere';
  sphere.mesh = mesh;
});

// ================================
// Ray Tracing Math Functions
// ================================

// Intersection with a sphere.
// Returns the smallest positive t (distance along the ray) or null if no hit.
function intersectRaySphere(origin, direction, sphere) {
  const oc = new THREE.Vector3().subVectors(origin, sphere.center);
  const a = direction.dot(direction); // should be 1 if normalized
  const b = 2 * oc.dot(direction);
  const c = oc.dot(oc) - sphere.radius * sphere.radius;
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return null;
  const sqrtDisc = Math.sqrt(discriminant);
  const t1 = (-b - sqrtDisc) / (2 * a);
  const t2 = (-b + sqrtDisc) / (2 * a);
  const epsilon = 1e-5;
  let t = null;
  if (t1 > epsilon && t2 > epsilon) {
    t = Math.min(t1, t2);
  } else if (t1 > epsilon) {
    t = t1;
  } else if (t2 > epsilon) {
    t = t2;
  }
  return t;
}

// Intersection with a plane given its data { point, normal }.
function intersectRayGeneralPlane(origin, direction, plane) {
  const denom = direction.dot(plane.normal);
  const epsilon = 1e-5;
  if (Math.abs(denom) < epsilon) return null; // Parallel to plane
  const diff = new THREE.Vector3().subVectors(plane.point, origin);
  const t = diff.dot(plane.normal) / denom;
  return t > epsilon ? t : null;
}

// Reflection: R = D - 2*(D·N)*N
function reflect(direction, normal) {
  const dot = direction.dot(normal);
  return new THREE.Vector3()
    .copy(direction)
    .sub(normal.clone().multiplyScalar(2 * dot))
    .normalize();
}

// Traces the ray through the scene (bouncing off spheres and planes).
// Returns an array of segments (each with 'start' and 'end' as THREE.Vector3).
function traceRay(origin, direction, spheres, planes, maxReflections) {
  const segments = [];
  let currentOrigin = origin.clone();
  let currentDirection = direction.clone().normalize();
  
  for (let i = 0; i < maxReflections; i++) {
    let closestT = Infinity;
    let hitObject = null; // { type: 'sphere', sphere } or { type: 'plane', plane }
    
    // Test spheres.
    for (const sphere of spheres) {
      const t = intersectRaySphere(currentOrigin, currentDirection, sphere);
      if (t !== null && t < closestT) {
        closestT = t;
        hitObject = { type: 'sphere', sphere: sphere };
      }
    }
    // Test planes.
    for (const plane of planes) {
      const t = intersectRayGeneralPlane(currentOrigin, currentDirection, plane);
      if (t !== null && t < closestT) {
        closestT = t;
        hitObject = { type: 'plane', plane: plane };
      }
    }
    
    if (!hitObject) {
      // Nothing hit: extend the ray.
      const tFar = 100;
      const endPoint = currentOrigin.clone().add(currentDirection.clone().multiplyScalar(tFar));
      segments.push({ start: currentOrigin.clone(), end: endPoint.clone() });
      break;
    } else {
      const hitPoint = currentOrigin.clone().add(currentDirection.clone().multiplyScalar(closestT));
      segments.push({ start: currentOrigin.clone(), end: hitPoint.clone() });
      
      // Determine normal.
      let normal;
      if (hitObject.type === 'sphere') {
        normal = hitPoint.clone().sub(hitObject.sphere.center).normalize();
      } else if (hitObject.type === 'plane') {
        normal = hitObject.plane.normal.clone();
      }
      
      currentOrigin = hitPoint;
      currentDirection = reflect(currentDirection, normal);
    }
  }
  return segments;
}

// ================================
// Create Multiple Rays
// ================================

// Parameters for rays.
const numberOfRays = 20;
const MAX_REFLECTIONS = 7;
const raySource = new THREE.Vector3(0, 12, -10);
// Define a base direction (approximately downward and forward).
const baseDirection = new THREE.Vector3(0, -0.8, 1).normalize();

// We'll store each ray's data (its computed segments and animation state) in an array.
const rays = [];
const SEGMENT_ANIMATION_TIME = 1000; // milliseconds per segment

for (let i = 0; i < numberOfRays; i++) {
  // Create a small random variation in angles.
  const randomAngleX = (Math.random() - 0.5) * 0.4; // ±0.2 radians
  const randomAngleY = (Math.random() - 0.5) * 0.4;
  const rayDir = baseDirection.clone().applyEuler(new THREE.Euler(randomAngleX, randomAngleY, 0, 'XYZ')).normalize();
  
  const segments = traceRay(raySource, rayDir, spheresData, planesData, MAX_REFLECTIONS);
  
  const rayData = {
    segments: segments,
    currentSegmentIndex: 0,
    segmentStartTime: Date.now() + Math.random() * 500, // slight random start offset
    completedLines: [],
    currentLine: null,
    group: new THREE.Group()
  };
  
  // Optionally, visualize the starting point with a small sphere.
  const startMarker = new THREE.Mesh(
    new THREE.SphereGeometry(0.15, 8, 8),
    new THREE.MeshBasicMaterial({ color: 0xffff00 })
  );
  startMarker.position.copy(raySource);
  rayData.group.add(startMarker);
  
  rays.push(rayData);
}

// Create a master group for all rays.
const raysGroup = new THREE.Group();
rays.forEach(ray => raysGroup.add(ray.group));
scene.add(raysGroup);

// Helper function: create a line between two points.
function createLine(start, end, color = 0xffff00) {
  const geometry = new THREE.BufferGeometry().setFromPoints([start, end]);
  const material = new THREE.LineBasicMaterial({ color: color });
  return new THREE.Line(geometry, material);
}

// ================================
// Animate the Rays
// ================================
function updateRay(rayData, now) {
  if (rayData.currentSegmentIndex < rayData.segments.length) {
    const seg = rayData.segments[rayData.currentSegmentIndex];
    const elapsed = now - rayData.segmentStartTime;
    const t = Math.min(elapsed / SEGMENT_ANIMATION_TIME, 1);
    const currentPoint = seg.start.clone().lerp(seg.end, t);
    
    if (rayData.currentLine) {
      rayData.group.remove(rayData.currentLine);
    }
    rayData.currentLine = createLine(seg.start, currentPoint);
    rayData.group.add(rayData.currentLine);
    
    if (t >= 1) {
      // Add the completed segment permanently.
      rayData.completedLines.push(createLine(seg.start, seg.end));
      rayData.group.add(rayData.completedLines[rayData.completedLines.length - 1]);
      rayData.currentSegmentIndex++;
      rayData.segmentStartTime = now;
      rayData.group.remove(rayData.currentLine);
      rayData.currentLine = null;
    }
  }
}

function animate() {
  requestAnimationFrame(animate);
  const now = Date.now();
  
  // Update each ray.
  rays.forEach(rayData => {
    updateRay(rayData, now);
  });
  
  controls.update();
  renderer.render(scene, camera);
}

animate();

// ================================
// Handle Window Resizing
// ================================
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});