import React, { useState, useEffect, useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import {
  SkinnedMesh,
  AnimationMixer,
  Clock,
  LoopRepeat,
  AnimationClip,
  VectorKeyframeTrack,
  SkeletonHelper,
  AnimationAction,
} from "three";
import { parsePvr, parsePvm } from "../lib/parsePvr";
import type { PVMEntry } from "../lib/parsePvr";
import { parseNinjaModel, NinjaModel } from "../lib/njParse";

interface NJViewerProps {
  modelPath: string;
  texturePaths?: string[];
  width?: number;
  height?: number;
}

// Component to handle the rotation of the model and animation
const Model: React.FC<{ 
  mesh: THREE.SkinnedMesh | THREE.Mesh, 
  showSkeleton: boolean,
  animations: THREE.AnimationClip[],
  currentAnimation: number | null,
  isPlaying: boolean,
  animationSpeed: number,
  setCurrentFrame: React.Dispatch<React.SetStateAction<number>>,
  setTotalFrames: React.Dispatch<React.SetStateAction<number>>,
  mixerRef: React.MutableRefObject<THREE.AnimationMixer | null>
}> = ({
  mesh,
  showSkeleton,
  animations,
  currentAnimation,
  isPlaying,
  animationSpeed,
  setCurrentFrame,
  setTotalFrames,
  mixerRef
}) => {
  const groupRef = useRef<THREE.Group>(null);
  const clock = useRef<THREE.Clock>(new THREE.Clock());
  const currentAction = useRef<THREE.AnimationAction | null>(null);

  // Initialize animation mixer if it's a skinned mesh
  useEffect(() => {
    if (mesh instanceof THREE.SkinnedMesh && mesh.skeleton) {
      // Create animation mixer for skeletal animation
      mixerRef.current = new THREE.AnimationMixer(mesh);
    }
  }, [mesh, mixerRef]);

  // Update active animation when currentAnimation changes
  useEffect(() => {
    if (!mixerRef.current) return;
    
    // Stop current animation if exists
    if (currentAction.current) {
      currentAction.current.stop();
      currentAction.current = null;
    }
    
    // Start new animation if selected
    if (currentAnimation !== null && animations[currentAnimation]) {
      const clip = animations[currentAnimation];
      currentAction.current = mixerRef.current.clipAction(clip);
      currentAction.current.setLoop(THREE.LoopRepeat, Infinity);
      currentAction.current.timeScale = animationSpeed;
      currentAction.current.play();
      
      // Set total frames based on animation duration
      const totalFrames = Math.floor(clip.duration * 30); // assuming 30fps
      setTotalFrames(totalFrames);
    } else {
      setTotalFrames(0);
    }
  }, [currentAnimation, animations, mixerRef, animationSpeed, setTotalFrames]);

  // Handle play/pause state
  useEffect(() => {
    if (!currentAction.current) return;
    
    if (isPlaying) {
      currentAction.current.paused = false;
    } else {
      currentAction.current.paused = true;
    }
  }, [isPlaying]);

  // Update animation speed
  useEffect(() => {
    if (currentAction.current) {
      currentAction.current.timeScale = animationSpeed;
    }
  }, [animationSpeed]);

  // Update skeleton helper visibility when showSkeleton changes
  useEffect(() => {
    if (mesh instanceof THREE.SkinnedMesh && mesh.userData.skeletonHelper) {
      mesh.userData.skeletonHelper.visible = showSkeleton;
    }
  }, [showSkeleton, mesh]);

  useFrame(() => {
    // Update animation mixer
    if (mixerRef.current && currentAction.current) {
      mixerRef.current.update(clock.current.getDelta());
      
      // Update current frame
      if (currentAnimation !== null && animations[currentAnimation]) {
        const clip = animations[currentAnimation];
        const clipTime = mixerRef.current.time % clip.duration;
        const frame = Math.floor(clipTime * 30); // assuming 30fps
        setCurrentFrame(frame);
      }
    }
  });

  return (
    <group ref={groupRef}>
      <primitive object={mesh} />
      {mesh instanceof THREE.SkinnedMesh && mesh.userData.skeletonHelper && (
        <primitive object={mesh.userData.skeletonHelper} />
      )}
    </group>
  );
};

const NJViewer: React.FC<NJViewerProps> = ({
  modelPath,
  texturePaths = [],
  width = 600,
  height = 400,
}) => {
  const [model, setModel] = useState<THREE.SkinnedMesh | THREE.Mesh | null>(
    null,
  );
  const [textures, setTextures] = useState<Map<number, THREE.Texture>>(
    new Map(),
  );
  const [textureCanvases, setTextureCanvases] = useState<
    Map<number, HTMLCanvasElement>
  >(new Map());
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [showSkeleton, setShowSkeleton] = useState<boolean>(false);
  const [animations, setAnimations] = useState<THREE.AnimationClip[]>([]);
  const [currentAnimation, setCurrentAnimation] = useState<number | null>(null);
  const [isPlaying, setIsPlaying] = useState<boolean>(true);
  const [animationSpeed, setAnimationSpeed] = useState<number>(1.0);
  const [currentFrame, setCurrentFrame] = useState<number>(0);
  const [totalFrames, setTotalFrames] = useState<number>(0);
  const mixerRef = useRef<THREE.AnimationMixer | null>(null);

  // Process a single texture entry from a PVM file
  const processTextureEntry = async (entry: PVMEntry, texturePath: string) => {
    try {
      const { imageData } = await parsePvr(entry.data);

      const canvas = document.createElement("canvas");
      canvas.width = imageData.width;
      canvas.height = imageData.height;
      canvas.style.border = "1px solid white";
      canvas.title = entry.name;

      const context = canvas.getContext("2d");
      if (!context) return null;

      context.putImageData(imageData, 0, 0);

      const texture = new THREE.CanvasTexture(canvas);
      texture.flipY = false;
      texture.name = entry.name;
      texture.needsUpdate = true;

      texture.userData = {
        applied: false,
        path: `${texturePath}/${entry.name}`,
        fromPVM: true,
      };

      console.log(
        `Successfully loaded texture: ${texture.name} (${imageData.width}x${imageData.height}) from PVM`,
      );

      return { texture, canvas };
    } catch (err) {
      console.warn(
        `Error processing PVR entry ${entry.name} in ${texturePath}:`,
        err,
      );
      return null;
    }
  };

  // Process a single PVR file
  const processPvrFile = async (
    buffer: ArrayBuffer,
    texturePath: string,
    index: number,
  ) => {
    try {
      const { imageData } = await parsePvr(buffer);

      const canvas = document.createElement("canvas");
      canvas.width = imageData.width;
      canvas.height = imageData.height;
      canvas.style.border = "1px solid white";
      canvas.title = texturePath.split("/").pop() || "";

      const context = canvas.getContext("2d");
      if (!context) return null;

      context.putImageData(imageData, 0, 0);

      const texture = new THREE.CanvasTexture(canvas);
      texture.flipY = false;
      texture.name = texturePath.split("/").pop() || "";
      texture.needsUpdate = true;

      texture.userData = {
        applied: false,
        index,
        path: texturePath,
      };

      console.log(
        `Successfully loaded texture: ${texture.name} (${imageData.width}x${imageData.height})`,
      );

      return { texture, canvas, key: index };
    } catch (err) {
      console.warn(`Error processing PVR file ${texturePath}:`, err);
      return null;
    }
  };

  // Process a PVM container file
  const processPvmFile = async (buffer: ArrayBuffer, texturePath: string) => {
    try {
      const entries = await parsePvm(buffer);
      console.log(`Successfully extracted ${entries.length} textures from PVM`);

      const results = await Promise.all(
        entries.map((entry) => processTextureEntry(entry, texturePath)),
      );

      return results.filter((result) => result !== null);
    } catch (err) {
      console.error(`Failed to parse PVM file ${texturePath}:`, err);
      return null;
    }
  };

  // Load model with available textures
  const loadModel = async (
    modelPath: string,
    textureMap: Map<number | string, THREE.Texture>,
  ) => {
    console.log(`Loading model: ${modelPath}`);
    const response = await fetch(`/iso/${modelPath}`);
    if (!response.ok) {
      throw new Error(`Failed to load model: ${response.statusText}`);
    }

    const modelBuffer = await response.arrayBuffer();
    const parsedModel = parseNinjaModel(modelBuffer);

    console.log("Parsed model:", parsedModel);
    console.log("TextureNames:", parsedModel.textureNames);
    console.log("Materials count:", parsedModel.materials?.length);
    
    // Check if animations exist and log them
    if (parsedModel.clips && parsedModel.clips.length > 0) {
      console.log("Animations found:", parsedModel.clips.length);
      setAnimations(parsedModel.clips);
    } else {
      console.log("No animations found");
      setAnimations([]);
    }

    if (!parsedModel.geometry || !parsedModel.materials) {
      throw new Error("Model missing geometry or materials");
    }

    // Create materials from the parsed model
    const materials = parsedModel.materials.map((materialOpts, index) => {
      // Basic material properties
      const material = new THREE.MeshPhongMaterial({
        side: materialOpts.doubleSide ? THREE.DoubleSide : THREE.FrontSide,
        transparent: materialOpts.blending || false,
        name: `Material_${index}`,
      });

      // Set colors if available
      if (materialOpts.diffuseColor) {
        material.color.setRGB(
          materialOpts.diffuseColor.r,
          materialOpts.diffuseColor.g,
          materialOpts.diffuseColor.b,
        );
        material.opacity = materialOpts.diffuseColor.a;
      }

      // Apply textures using different strategies
      applyTextureToMaterial(
        material,
        materialOpts,
        parsedModel,
        textureMap,
        index,
      );

      return material;
    });

    // If no materials defined, create a default material
    if (materials.length === 0) {
      materials.push(new THREE.MeshNormalMaterial());
    }

    // Log groups info for debugging
    if (parsedModel.geometry.groups && parsedModel.geometry.groups.length > 0) {
      console.log("Material groups in geometry:", parsedModel.geometry.groups);
      parsedModel.geometry.groups.forEach((group, i) => {
        console.log(
          `Group ${i}: materialIndex=${group.materialIndex}, start=${group.start}, count=${group.count}`,
        );
      });
    } else {
      console.log("No material groups found in geometry");
    }

    // Create the mesh with the geometry and materials
    const mesh = new THREE.SkinnedMesh(parsedModel.geometry, materials);
    console.log("Created mesh with", materials.length, "materials");
    const skeleton = new THREE.Skeleton(parsedModel.bones);
    const rootBone = skeleton.bones[0];
    mesh.add(rootBone);
    mesh.bind(skeleton);
    
    // Attach skeleton to userData for reference
    mesh.userData.skeletonHelper = new THREE.SkeletonHelper(mesh);
    mesh.userData.skeletonHelper.visible = false;

    return mesh;
  };

  // Apply texture to material using different strategies
  const applyTextureToMaterial = (
    material: THREE.MeshPhongMaterial,
    materialOpts: any,
    parsedModel: NinjaModel,
    textureMap: Map<number | string, THREE.Texture>,
    materialIndex: number,
  ) => {
    let textureApplied = false;

    // Strategy 1: Direct texture name match from PVM
    if (
      parsedModel.textureNames &&
      parsedModel.textureNames.length > materialOpts.texId
    ) {
      const textureName = parsedModel.textureNames[materialOpts.texId];
      if (textureName && textureMap.has(textureName)) {
        const texture = textureMap.get(textureName);
        material.map = texture;
        material.needsUpdate = true;
        texture.userData.applied = true;
        console.log(
          `Applied texture "${textureName}" directly from PVM to material ${materialIndex}`,
        );
        textureApplied = true;
      }
    }

    // Strategy 2: By index for single PVR files
    if (
      !textureApplied &&
      materialOpts.texId >= 0 &&
      textureMap.has(materialOpts.texId)
    ) {
      const texture = textureMap.get(materialOpts.texId);
      material.map = texture;
      material.needsUpdate = true;
      texture.userData.applied = true;
      console.log(
        `Applied texture by index ${materialOpts.texId} to material ${materialIndex}`,
      );
      textureApplied = true;
    }

    // Strategy 3: Texture name fuzzy matching
    if (
      !textureApplied &&
      parsedModel.textureNames &&
      parsedModel.textureNames.length > materialOpts.texId
    ) {
      const textureName = parsedModel.textureNames[materialOpts.texId];

      for (const [key, texture] of textureMap.entries()) {
        if (
          key === textureName ||
          (typeof key === "string" &&
            key.toLowerCase() === textureName.toLowerCase()) ||
          (typeof key === "string" &&
            key.split("/").pop()?.split(".")[0]?.toLowerCase() ===
              textureName.toLowerCase())
        ) {
          material.map = texture;
          material.needsUpdate = true;
          texture.userData.applied = true;
          console.log(
            `Applied texture "${key}" to material ${materialIndex} by name matching with "${textureName}"`,
          );
          textureApplied = true;
          break;
        }
      }

      if (!textureApplied) {
        console.log(`No matching texture found for name: ${textureName}`);
      }
    }

    if (!textureApplied) {
      console.log(
        `No texture applied to material ${materialIndex} with texId: ${materialOpts.texId}`,
      );
    }

    // Always ensure textures are properly updated
    if (material.map) {
      material.map.needsUpdate = true;
    }
  };

  // Combined loading function for sequential loading
  useEffect(() => {
    const loadAll = async () => {
      console.log("Starting sequential loading process");
      setLoading(true);
      setError(null);

      // Step 1: Load textures first
      console.log("Step 1: Loading textures");
      const textureMap = new Map<number | string, THREE.Texture>();
      const canvasesMap = new Map<number | string, HTMLCanvasElement>();

      for (let i = 0; i < texturePaths.length; i++) {
        const texturePath = texturePaths[i];

        console.log(`Loading texture from: /iso/${texturePath}`);
        const response = await fetch(`/iso/${texturePath}`);
        if (!response.ok) {
          console.warn(`Failed to load texture: ${texturePath}`);
          continue;
        }

        const buffer = await response.arrayBuffer();
        const isPVM = texturePath.toLowerCase().endsWith(".pvm");

        if (isPVM) {
          console.log("Processing PVM file...");
          const results = await processPvmFile(buffer, texturePath);
          if (!results) {
            throw new Error("Unable to process pvm!!???");
          }
          results.forEach((result) => {
            if (result) {
              textureMap.set(result.texture.name, result.texture);
              canvasesMap.set(result.texture.name, result.canvas);
            }
          });
        } else {
          // Process as regular PVR file
          const result = await processPvrFile(buffer, texturePath, i);
          if (result) {
            textureMap.set(result.key, result.texture);
            canvasesMap.set(result.key, result.canvas);
          }
        }
      }

      console.log(`Loaded ${textureMap.size} textures`);

      // Update state with loaded textures
      setTextures(textureMap);
      setTextureCanvases(canvasesMap);

      // Step 2: Now load the model with the loaded textures
      const mesh = await loadModel(modelPath, textureMap);
      setModel(mesh);

      // Step 3: Remove Loading
      setLoading(false);
    };

    loadAll(); // Start the sequential loading process
  }, [modelPath, texturePaths]); // Only depends on the paths, not the loaded textures

  return (
    <div className="nj-viewer-container">
      <div
        className="nj-viewer-canvas border border-gray-300 rounded-md overflow-hidden relative"
        style={{ width, height }}
      >
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-black bg-opacity-30 z-10">
            <div className="text-white">Loading model...</div>
          </div>
        )}

        {error && (
          <div className="absolute inset-0 flex items-center justify-center bg-black bg-opacity-30 z-10">
            <div className="text-red-500">{error}</div>
          </div>
        )}

        <Canvas camera={{ position: [0, 2, 5], fov: 50 }}>
          <ambientLight intensity={0.5} />
          <pointLight position={[10, 10, 10]} intensity={1} />
          <pointLight
            position={[-10, -10, -10]}
            intensity={0.5}
            color="#8080ff"
          />

          {model ? (
            <Model 
              mesh={model} 
              showSkeleton={showSkeleton} 
              animations={animations}
              currentAnimation={currentAnimation}
              isPlaying={isPlaying}
              animationSpeed={animationSpeed}
              setCurrentFrame={setCurrentFrame}
              setTotalFrames={setTotalFrames}
              mixerRef={mixerRef}
            />
          ) : (
            // Placeholder box while loading
            <mesh>
              <boxGeometry args={[1, 1, 1]} />
              <meshStandardMaterial color="#6be092" />
            </mesh>
          )}

          <OrbitControls />
          <gridHelper args={[10, 10]} />
          <axesHelper args={[5]} />
        </Canvas>
      </div>

      {/* Controls Section */}
      <div className="controls-section" style={{ marginTop: "10px", marginBottom: "10px" }}>
        <div style={{ display: "flex", gap: "10px", marginBottom: "10px" }}>
          <button 
            onClick={() => setShowSkeleton(!showSkeleton)}
            className="px-2 py-1 bg-blue-600 text-white rounded hover:bg-blue-700"
            style={{ 
              padding: "4px 8px",
              backgroundColor: showSkeleton ? "#4c1d95" : "#2563eb",
              color: "white", 
              borderRadius: "4px",
              border: "none",
              cursor: "pointer"
            }}
          >
            {showSkeleton ? "Hide Skeleton" : "Show Skeleton"}
          </button>
        </div>

        {/* Animation Controls - Only show if animations exist */}
        {animations.length > 0 && (
          <div className="animation-controls" style={{ 
            display: "flex", 
            flexDirection: "column", 
            gap: "10px", 
            backgroundColor: "#1a1a2e", 
            padding: "12px", 
            borderRadius: "6px" 
          }}>
            <h3 style={{ fontSize: "14px", margin: "0 0 10px 0", color: "white" }}>Animation Controls</h3>
            
            {/* Animation Selection */}
            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                <label style={{ color: "white", display: "flex", alignItems: "center", gap: "4px" }}>
                  <input 
                    type="radio" 
                    name="animation" 
                    checked={currentAnimation === null} 
                    onChange={() => setCurrentAnimation(null)}
                  />
                  None
                </label>
                {animations.map((anim, index) => (
                  <label 
                    key={index} 
                    style={{ color: "white", display: "flex", alignItems: "center", gap: "4px" }}
                  >
                    <input 
                      type="radio" 
                      name="animation" 
                      checked={currentAnimation === index} 
                      onChange={() => setCurrentAnimation(index)}
                    />
                    {anim.name}
                  </label>
                ))}
              </div>
            </div>
            
            {/* Animation playback controls */}
            {currentAnimation !== null && (
              <>
                {/* Playback buttons */}
                <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                  <button 
                    onClick={() => setIsPlaying(!isPlaying)} 
                    style={{ 
                      padding: "4px 8px", 
                      backgroundColor: "#4C1D95", 
                      color: "white", 
                      border: "none", 
                      borderRadius: "4px", 
                      cursor: "pointer" 
                    }}
                  >
                    {isPlaying ? "Pause" : "Play"}
                  </button>
                  
                  <button 
                    onClick={() => {
                      if (mixerRef.current && currentAnimation !== null && animations[currentAnimation]) {
                        // Jump to previous frame
                        const clip = animations[currentAnimation];
                        let newFrame = currentFrame - 1;
                        if (newFrame < 0) newFrame = totalFrames - 1;
                        mixerRef.current.setTime((newFrame / 30) % clip.duration);
                      }
                    }}
                    style={{ 
                      padding: "4px 8px", 
                      backgroundColor: "#374151", 
                      color: "white", 
                      border: "none", 
                      borderRadius: "4px", 
                      cursor: "pointer" 
                    }}
                  >
                    ⏮ Prev Frame
                  </button>
                  
                  <button 
                    onClick={() => {
                      if (mixerRef.current && currentAnimation !== null && animations[currentAnimation]) {
                        // Jump to next frame
                        const clip = animations[currentAnimation];
                        const newFrame = (currentFrame + 1) % totalFrames;
                        mixerRef.current.setTime((newFrame / 30) % clip.duration);
                      }
                    }}
                    style={{ 
                      padding: "4px 8px", 
                      backgroundColor: "#374151", 
                      color: "white", 
                      border: "none", 
                      borderRadius: "4px", 
                      cursor: "pointer" 
                    }}
                  >
                    Next Frame ⏭
                  </button>
                  
                  <div style={{ marginLeft: "10px", display: "flex", alignItems: "center", gap: "8px" }}>
                    <label style={{ color: "white", fontSize: "12px" }}>Speed:</label>
                    <input 
                      type="range" 
                      min="0.1" 
                      max="2" 
                      step="0.1" 
                      value={animationSpeed} 
                      onChange={(e) => setAnimationSpeed(parseFloat(e.target.value))}
                      style={{ width: "100px" }}
                    />
                    <span style={{ color: "white", fontSize: "12px" }}>{animationSpeed.toFixed(1)}x</span>
                  </div>
                </div>
                
                {/* Progress bar */}
                <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                  <div style={{ flex: 1, height: "8px", backgroundColor: "#1E293B", borderRadius: "4px", overflow: "hidden" }}>
                    <div 
                      style={{ 
                        width: `${totalFrames > 0 ? (currentFrame / totalFrames) * 100 : 0}%`, 
                        height: "100%", 
                        backgroundColor: "#3B82F6",
                        transition: "width 0.1s ease"
                      }}
                    />
                  </div>
                  <div style={{ color: "white", fontSize: "12px", whiteSpace: "nowrap" }}>
                    {currentFrame} / {totalFrames}
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* Texture Debug Panel */}
      <div
        className="texture-debug-panel"
        style={{
          marginTop: "10px",
          display: "flex",
          flexWrap: "wrap",
          gap: "10px",
        }}
      >
        <div style={{ width: "100%" }}>
          <h3 style={{ fontSize: "14px", marginBottom: "5px" }}>
            Texture Debug Panel:
          </h3>
        </div>
        {Array.from(textureCanvases.entries()).map(([key, canvas]) => {
          // For numeric keys (old style) or string keys (from PVM)
          const texture =
            typeof key === "number" ? textures.get(key) : textures.get(key);
          const isApplied = texture?.userData?.applied || false;
          const textureName = texture?.name || `Texture ${key}`;
          const texturePath = texture?.userData?.path || "";
          const fromPVM = texture?.userData?.fromPVM || false;

          return (
            <div
              key={typeof key === "string" ? key : String(key)}
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                border: isApplied ? "2px solid green" : "2px solid red",
                padding: "5px",
                borderRadius: "4px",
                background: fromPVM ? "#223322" : "#222",
              }}
            >
              <div
                style={{
                  fontSize: "12px",
                  color: isApplied ? "lightgreen" : "salmon",
                  marginBottom: "3px",
                  whiteSpace: "nowrap",
                }}
              >
                {isApplied ? "✓ " : "✗ "}
                {textureName}
              </div>
              <div
                style={{
                  display: "flex",
                  justifyContent: "center",
                  alignItems: "center",
                  width: "64px",
                  height: "64px",
                  overflow: "hidden",
                }}
              >
                <canvas
                  ref={(ref) => {
                    if (ref) {
                      const ctx = ref.getContext("2d");
                      if (ctx) {
                        const scale = Math.min(
                          64 / canvas.width,
                          64 / canvas.height,
                        );
                        ref.width = canvas.width * scale;
                        ref.height = canvas.height * scale;
                        ctx.scale(scale, scale);
                        ctx.drawImage(canvas, 0, 0);
                      }
                    }
                  }}
                  width={64}
                  height={64}
                  title={`Key: ${key}, Name: ${textureName}, Applied: ${isApplied}${fromPVM ? ", From PVM" : ""}, Path: ${texturePath}`}
                />
              </div>
              <div
                style={{ fontSize: "10px", color: "#aaa", marginTop: "3px" }}
              >
                {canvas.width}x{canvas.height}
              </div>
            </div>
          );
        })}
        {textureCanvases.size === 0 && (
          <div style={{ color: "#aaa", fontSize: "12px" }}>
            No textures loaded
          </div>
        )}
      </div>
    </div>
  );
};

export default NJViewer;
