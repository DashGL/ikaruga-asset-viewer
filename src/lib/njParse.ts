import {
  AnimationClip,
  VectorKeyframeTrack,
  QuaternionKeyframeTrack,
  NormalAnimationBlendMode,
  Bone,
  Vector3,
  Euler,
  Quaternion,
  Matrix3,
  Matrix4,
  BufferGeometry,
  BufferAttribute,
  SkinnedMesh,
  MeshBasicMaterial,
  Material,
  DoubleSide,
} from "three";
import type { AnimationClipJSON } from "three";
import ByteReader from "bytereader";

interface MaterialOptions {
  texId: number;
  blending: boolean;
  doubleSide: boolean;
  diffuseColor?: { r: number; g: number; b: number; a: number };
  specularColor?: { r: number; g: number; b: number; a: number };
  ambientColor?: { r: number; g: number; b: number; a: number };
}

interface Vertex {
  position: Vector3;
  normal?: Vector3;
  color?: {
    r: number;
    g: number;
    b: number;
    a: number;
  };
  uv?: {
    x: number;
    y: number;
  };
  skinIndices?: number[];
  skinWeights?: number[];
  globalIndex?: number;
}

// Better organized vertex storage
class VertexList {
  private vertices: (Vertex | null)[] = [];

  addVertex(vertex: Vertex, index: number): void {
    // Ensure array is large enough
    while (this.vertices.length <= index) {
      this.vertices.push(null);
    }
    this.vertices[index] = vertex;
  }

  getVertex(index: number): Vertex | null {
    if (index < 0 || index >= this.vertices.length) {
      return null;
    }
    return this.vertices[index];
  }

  setUV(index: number, u: number, v: number): void {
    if (index >= 0 && index < this.vertices.length && this.vertices[index]) {
      this.vertices[index].uv = { x: u, y: v };
    }
  }

  getAllVertices(): Vertex[] {
    return this.vertices.filter((v) => v !== null);
  }

  getTriangleData(indices: number[]): {
    positions: number[];
    normals: number[];
    colors: number[];
    uvs: number[];
    skinIndices: number[];
    skinWeights: number[];
  } {
    const positions: number[] = [];
    const normals: number[] = [];
    const colors: number[] = [];
    const uvs: number[] = [];
    const skinIndices: number[] = [];
    const skinWeights: number[] = [];

    // Process each index and extract data
    for (const idx of indices) {
      const vertex = this.getVertex(idx);
      if (!vertex) continue;

      // Add position
      positions.push(vertex.position.x, vertex.position.y, vertex.position.z);

      // Add normal if exists
      if (vertex.normal) {
        normals.push(vertex.normal.x, vertex.normal.y, vertex.normal.z);
      }

      // Add color if exists
      if (vertex.color) {
        const alpha = vertex.color.a < 0.3 ? 0.3 : vertex.color.a; // Ensure minimum alpha
        colors.push(vertex.color.r, vertex.color.g, vertex.color.b, alpha);
      }

      // Add UV if exists
      if (vertex.uv) {
        uvs.push(vertex.uv.x, vertex.uv.y);
      } else {
        uvs.push(0, 0); // Default UV
      }

      // Add skinning data if exists
      if (vertex.skinIndices && vertex.skinWeights) {
        skinIndices.push(...vertex.skinIndices);
        skinWeights.push(...vertex.skinWeights);
      }
    }

    return { positions, normals, colors, uvs, skinIndices, skinWeights };
  }
}

class NinjaModel {
  private reader: ByteReader;
  private bones: Bone[];
  private vertices: number[] = [];
  private normals: number[] = [];
  private colors: number[] = [];
  private uvs: number[] = [];
  private skinIndices: number[] = [];
  private skinWeights: number[] = [];
  private indices: number[] = [];
  private materialIndices: number[] = [];
  private materials: MaterialOptions[] = [];
  private vertexList: VertexList = new VertexList();
  private memStack: number[] = [];
  private currentBone: Bone | null = null;
  private currentMaterial: MaterialOptions = {
    texId: -1,
    blending: false,
    doubleSide: false,
    diffuseColor: { r: 1, g: 1, b: 1, a: 1 },
  };
  private currentColor = { r: 1, g: 1, b: 1, a: 1 };
  private flipV: boolean = false;

  constructor(reader: ByteReader) {
    this.reader = reader;
    this.bones = [];
  }

  readVector3() {
    const x = this.reader.readFloat();
    const y = this.reader.readFloat();
    const z = this.reader.readFloat();
    return new Vector3(x, y, z);
  }

  readRotation(isZxy: boolean) {
    const ratio = (2 * Math.PI) / 0xffff;
    const x = this.reader.readInt32() * ratio;
    const y = this.reader.readInt32() * ratio;
    const z = this.reader.readInt32() * ratio;
    return isZxy ? new Euler(z, x, y) : new Euler(x, y, z);
  }

  readQuaternion() {
    const x = this.reader.readFloat();
    const y = this.reader.readFloat();
    const z = this.reader.readFloat();
    const w = this.reader.readFloat();
    return new Quaternion(x, y, z, w);
  }

  readColor() {
    const b = this.reader.readUInt8() / 255;
    const g = this.reader.readUInt8() / 255;
    const r = this.reader.readUInt8() / 255;
    const a = this.reader.readUInt8() / 255;
    return { r, g, b, a };
  }

  isBitFlagSet(value: number, bit: number): boolean {
    return (value & (1 << bit)) !== 0;
  }

  getBitMask(value: number, bits: number[]): number {
    let result = 0;
    for (let i = 0; i < bits.length; i++) {
      const bit = bits[i];
      if (this.isBitFlagSet(value, bit)) {
        result |= 1 << i;
      }
    }
    return result;
  }

  readBone(parentBone?: Bone) {
    // Read bone structure
    const boneOffset = this.reader.tell();
    const flags = this.reader.readUInt32();
    const chunkOfs = this.reader.readUInt32();
    const pos = this.readVector3();

    // Euler rotation
    const rot = this.readRotation(this.isBitFlagSet(flags, 5));
    const scl = this.readVector3();
    const childOfs = this.reader.readUInt32();
    const siblingOfs = this.reader.readUInt32();

    // Create new bone
    const bone = new Bone();
    bone.name = `bone_${this.bones.length.toString().padStart(3, "0")}`;
    this.bones.push(bone);
    this.currentBone = bone;

    // Apply scale if not ignoring scale
    if (!this.isBitFlagSet(flags, 2)) {
      bone.scale.copy(scl);
    }

    // Apply rotation if not ignoring rotation
    if (!this.isBitFlagSet(flags, 1)) {
      // Euler rotation
      bone.rotation.copy(rot);
    }

    // Apply position if not ignoring position
    if (!this.isBitFlagSet(flags, 0)) {
      bone.position.copy(pos);
    }

    // Update matrices
    bone.updateMatrix();
    bone.updateWorldMatrix(true, true);

    // If parent bone exists, add this bone as a child
    if (parentBone) {
      parentBone.add(bone);
      bone.updateMatrix();
      bone.updateWorldMatrix(true, true);
    }

    // If there's a chunk for this bone, process it
    if (chunkOfs) {
      const currentPos = this.reader.tell();
      this.reader.seek(chunkOfs);

      console.log("Seeking to submesh definition: 0x%s", chunkOfs.toString(16));
      const vertexOfs = this.reader.readUInt32();
      const stripOfs = this.reader.readUInt32();

      if (vertexOfs) {
        console.log(
          "READING CHUNK VERTEX LIST AT: 0x%s",
          vertexOfs.toString(16),
        );
        this.reader.seek(vertexOfs);
        this.readChunk();
      }

      if (stripOfs) {
        this.reader.seek(stripOfs);
        this.readChunk();
      }

      this.reader.seek(currentPos);
    }

    // Process child and sibling bones if needed
    if (childOfs) {
      const currentPos = this.reader.tell();
      this.reader.seek(childOfs);
      this.readBone(bone);
      this.reader.seek(currentPos);
    }

    if (siblingOfs) {
      const currentPos = this.reader.tell();
      this.reader.seek(siblingOfs);
      this.readBone(parentBone);
      this.reader.seek(currentPos);
    }
  }

  readChunk() {
    const NJD_NULLOFF = 0x00;
    const NJD_BITSOFF = 0x01;
    const NJD_TINYOFF = 0x08;
    const NJD_MATOFF = 0x10;
    const NJD_VERTOFF = 0x20;
    const NJD_VOLOFF = 0x38;
    const NJD_STRIPOFF = 0x40;
    const NJD_ENDOFF = 0xff;

    this.currentMaterial = {
      texId: -1,
      blending: false,
      doubleSide: false,
    };

    this.currentColor = {
      r: 1,
      g: 1,
      b: 1,
      a: 1,
    };

    let chunk;

    console.log("READING CHUNK AT 0x%s", this.reader.tellf());

    do {
      const head = this.reader.readUInt8();
      const flag = this.reader.readUInt8();
      chunk = { head, flag };

      if (chunk.head == NJD_ENDOFF) {
        console.log("End of Chunks!!!");
        break;
      }
      // Invalid Chunk
      if (chunk.head > NJD_STRIPOFF + 11) {
        console.log("INVALID CHUNK!!!???? T_T");
        continue;
      }

      // Strip Chunk
      if (chunk.head >= NJD_STRIPOFF) {
        console.log("READING A STRIP CHUNK!!!");
        this.readStripChunk(chunk);
        continue;
      }

      // Volume Chunk
      if (chunk.head >= NJD_VOLOFF) {
        throw new Error("Volume chunk not implemented");
      }

      // Vertex Chunk
      if (chunk.head >= NJD_VERTOFF) {
        console.log("Reading Vertex Chunk!!!");
        this.readVertexChunk(chunk);
        continue;
      }

      // Material Chunk
      if (chunk.head >= NJD_MATOFF) {
        console.log("MATERIAL CHUNK!!!");
        this.readMaterialChunk(chunk);
        continue;
      }

      // Tiny Chunk
      if (chunk.head >= NJD_TINYOFF) {
        console.log("TINY CHUNK!!!!");
        this.readTinyChunk(chunk);
        continue;
      }

      // Bits Chunk
      if (chunk.head >= NJD_BITSOFF) {
        console.log("BITS CHUNK!!!!");
        this.readBitsChunk(chunk);
        continue;
      }
    } while (chunk.head !== NJD_ENDOFF);

    // Process memory stack if needed
    if (this.memStack && this.memStack.length) {
      const offset = this.memStack.pop();
      if (offset !== undefined) {
        this.reader.seek(offset);
        this.readChunk();
      }
    }
  }

  readBitsChunk(chunk: { head: number; flag: number }) {
    switch (chunk.head) {
      case 1:
        const dstAlpha = this.getBitMask(chunk.flag, [0, 1, 2]);
        const srcAlpha = this.getBitMask(chunk.flag, [3, 4, 5]);

        if (srcAlpha === 4 && dstAlpha === 1) {
          this.currentMaterial.blending = true;
        } else {
          this.currentMaterial.blending = false;
        }
        break;

      case 2:
        const mipmapDepth = chunk.flag & 0x0f;
        break;

      case 3:
        const specularCoef = chunk.flag & 0x1f;
        break;

      case 4:
        // Store offset for later
        const storeOffset = this.reader.tell() + chunk.flag;
        break;

      case 5:
        // Push current position to memory stack and restore a previously stored offset
        this.memStack = this.memStack || [];
        this.memStack.push(this.reader.tell());
        this.reader.seekRel(chunk.flag);
        break;
    }
  }

  readTinyChunk(chunk: { head: number; flag: number }) {
    const tinyChunk = this.reader.readUInt16();
    const textureId = tinyChunk & 0x1fff;

    this.currentMaterial.texId = textureId;

    const superSample = this.isBitFlagSet(tinyChunk, 13);
    const filterMode = this.getBitMask(tinyChunk, [14, 15]);

    const clampU = this.isBitFlagSet(chunk.head, 4);
    const clampV = this.isBitFlagSet(chunk.head, 5);
    const flipU = this.isBitFlagSet(chunk.head, 6);
    const flipV = this.isBitFlagSet(chunk.head, 7);

    this.flipV = flipV;
  }

  readMaterialChunk(chunk: { head: number; flag: number }) {
    const length = this.reader.readUInt16();

    // Alpha Blending Instructions
    const dstAlpha = this.getBitMask(chunk.flag, [0, 1, 2]);
    const srcAlpha = this.getBitMask(chunk.flag, [3, 4, 5]);

    if (srcAlpha === 4 && dstAlpha === 1) {
      this.currentMaterial.blending = true;
    } else {
      this.currentMaterial.blending = false;
    }

    // Diffuse color
    if (this.isBitFlagSet(chunk.head, 0)) {
      const diffuse = this.readColor();
      this.currentColor = diffuse; // Set current color for vertices
      this.currentMaterial.diffuseColor = diffuse; // Store in material
    }

    // Specular
    if (this.isBitFlagSet(chunk.head, 1)) {
      const specular = this.readColor();
      this.currentMaterial.specularColor = specular;
    }

    // Ambient
    if (this.isBitFlagSet(chunk.head, 2)) {
      const ambient = this.readColor();
      this.currentMaterial.ambientColor = ambient;
    }
  }

  readVertexChunk(chunk: { head: number; flag: number }) {
    const length = this.reader.readUInt16();

    // Read index offset and count
    const indexOffset = this.reader.readUInt16();
    const vertexCount = this.reader.readUInt16();
    console.log("Index: %d", indexOffset);
    console.log("Vertex Cound: %s", vertexCount);

    // Read vertices
    for (let i = 0; i < vertexCount; i++) {
      const stackIndex = indexOffset + i;

      // Read position
      const position = this.readVector3();
      const vertex: Vertex = { position };

      // Transform by bone matrix
      if (this.currentBone) {
        const worldPos = position
          .clone()
          .applyMatrix4(this.currentBone.matrixWorld);
        vertex.position = worldPos;
      }

      // Read normal if present
      if (chunk.head > 0x28 && chunk.head < 0x30) {
        const normal = this.readVector3();
        // Transform normal by bone matrix
        if (this.currentBone) {
          // For normals, we need to use the normal matrix (inverse transpose of the world matrix)
          const normalMatrix = new Matrix3().getNormalMatrix(
            this.currentBone.matrixWorld,
          );
          const worldNormal = normal.clone().applyMatrix3(normalMatrix);
          // Normalize to ensure unit length after transformation
          worldNormal.normalize();
          vertex.normal = worldNormal;
        } else {
          vertex.normal = normal;
        }
      }

      // Read vertex color if present
      if (chunk.head === 0x23 || chunk.head === 0x2a) {
        vertex.color = this.readColor();
      }

      // Setup skinning weights
      const skinIndices = [0, 0, 0, 0];
      const skinWeights = [0, 0, 0, 0];

      if (chunk.head !== 0x2c) {
        // Simple bone weighting
        skinIndices[0] = this.bones.length - 1;
        skinWeights[0] = 1.0;
      } else {
        console.log("OMG WE HAVE SUB WEIGHTS!!!!!");
        // Read weight values
        const offset = this.reader.readUInt16();
        const weight = this.reader.readUInt16();

        // Update stack index
        const stackPos = indexOffset + offset;

        // Get existing weights if available
        const prev = this.vertexList.getVertex(stackPos);
        if (prev && prev.skinIndices && prev.skinWeights) {
          skinIndices[0] = prev.skinIndices[0] || 0;
          skinIndices[1] = prev.skinIndices[1] || 0;
          skinIndices[2] = prev.skinIndices[2] || 0;

          skinWeights[0] = prev.skinWeights[0] || 0;
          skinWeights[1] = prev.skinWeights[1] || 0;
          skinWeights[2] = prev.skinWeights[2] || 0;
        }

        // Set weights based on flag
        switch (chunk.flag) {
          case 0x80:
            skinIndices[0] = this.bones.length - 1;
            skinWeights[0] = weight / 255;
            break;
          case 0x81:
            skinIndices[1] = this.bones.length - 1;
            skinWeights[1] = weight / 255;
            break;
          case 0x82:
            skinIndices[2] = this.bones.length - 1;
            skinWeights[2] = weight / 255;
            break;
        }
      }

      vertex.skinIndices = skinIndices;
      vertex.skinWeights = skinWeights;
      vertex.globalIndex = stackIndex;

      // Add to the improved vertex list
      this.vertexList.addVertex(vertex, stackIndex);
    }
  }

  getMaterialIndex(): number {
    // Check if material already exists
    for (let i = 0; i < this.materials.length; i++) {
      const mat = this.materials[i];

      // Check basic properties
      if (
        mat.texId === this.currentMaterial.texId &&
        mat.blending === this.currentMaterial.blending &&
        mat.doubleSide === this.currentMaterial.doubleSide
      ) {
        // Check color properties if they exist
        const diffuseMatch = this.colorsEqual(
          mat.diffuseColor,
          this.currentMaterial.diffuseColor,
        );
        const specularMatch = this.colorsEqual(
          mat.specularColor,
          this.currentMaterial.specularColor,
        );
        const ambientMatch = this.colorsEqual(
          mat.ambientColor,
          this.currentMaterial.ambientColor,
        );

        if (diffuseMatch && specularMatch && ambientMatch) {
          return i; // Reuse existing material
        }
      }
    }

    // If not, create a new material with all current properties
    const materialIndex = this.materials.length;
    this.materials.push({
      texId: this.currentMaterial.texId,
      blending: this.currentMaterial.blending,
      doubleSide: this.currentMaterial.doubleSide,
      diffuseColor: this.currentMaterial.diffuseColor
        ? { ...this.currentMaterial.diffuseColor }
        : undefined,
      specularColor: this.currentMaterial.specularColor
        ? { ...this.currentMaterial.specularColor }
        : undefined,
      ambientColor: this.currentMaterial.ambientColor
        ? { ...this.currentMaterial.ambientColor }
        : undefined,
    });

    return materialIndex;
  }

  private colorsEqual(
    color1?: { r: number; g: number; b: number; a: number },
    color2?: { r: number; g: number; b: number; a: number },
  ): boolean {
    // If both are undefined or null, they're equal
    if (!color1 && !color2) return true;
    // If only one is undefined or null, they're not equal
    if (!color1 || !color2) return false;

    // Compare values with a small epsilon for float comparison
    const epsilon = 0.00001;
    return (
      Math.abs(color1.r - color2.r) < epsilon &&
      Math.abs(color1.g - color2.g) < epsilon &&
      Math.abs(color1.b - color2.b) < epsilon &&
      Math.abs(color1.a - color2.a) < epsilon
    );
  }

  readStripChunk(chunk: { head: number; flag: number }) {
    const length = this.reader.readUInt16();

    console.log("Strip start: ", this.reader.tellf());
    console.log(
      "Expected end: 0x%s",
      (this.reader.tell() + length * 2).toString(16),
    );
    const expectedEnd = this.reader.tell() + length * 2;
    // Read strip info
    const stripInfo = this.reader.readUInt16();
    const stripCount = stripInfo & 0x3fff;
    const userOffset = stripInfo >> 14;
    console.log("USER OFFSET: ", userOffset);

    this.currentMaterial.doubleSide = this.isBitFlagSet(chunk.flag, 4);
    const materialIndex = this.getMaterialIndex();

    console.log("Number strips: ", stripCount);
    // Process strips
    for (let stripIdx = 0; stripIdx < stripCount; stripIdx++) {
      // Read strip length

      console.log("Reading strip at: ", this.reader.tellf());
      const rawLength = this.reader.readInt16();
      const clockwise = rawLength < 0;
      const stripLength = Math.abs(rawLength);

      console.log("Strip length: %s", rawLength);
      const strip = new Array(stripLength);

      // Read each vertex in the strip
      for (let vertIdx = 0; vertIdx < stripLength; vertIdx++) {
        const stackIndex = this.reader.readUInt16();

        const vertex = this.vertexList.getVertex(stackIndex);
        if (!vertex) {
          throw new Error(`Vertex ${stackIndex} not found in vertex list`);
        }

        strip[vertIdx] = {
          vertex: vertex,
          uv: { x: 0, y: 0 },
        };

        // Read UVs if present
        if (chunk.head === 0x41) {
          const u = this.reader.readInt16() / 255;
          const v = this.flipV
            ? this.reader.readInt16() / 255
            : 1 - this.reader.readInt16() / 255;
          strip[vertIdx].uv = { x: u, y: v };
          // Store UV in the actual vertex for better organization
          this.vertexList.setUV(stackIndex, u, v);
        } else if (chunk.head === 0x42) {
          const u = this.reader.readInt16() / 1023;
          const v = this.flipV
            ? this.reader.readInt16() / 1023
            : 1 - this.reader.readInt16() / 1023;
          strip[vertIdx].uv = { x: u, y: v };
          // Store UV in the actual vertex for better organization
          this.vertexList.setUV(stackIndex, u, v);
        }

        // Skip user offset data
        // if (userOffset && vertIdx > 1) {
        //   this.reader.seekRel(userOffset * 2);
        // }
      }

      // Convert strip to triangles
      for (let i = 0; i < stripLength - 2; i++) {
        // Determine vertex order based on clockwise flag and index parity
        const indices = [];
        if ((clockwise && !(i % 2)) || (!clockwise && i % 2)) {
          indices.push(
            strip[i].vertex.globalIndex,
            strip[i + 2].vertex.globalIndex,
            strip[i + 1].vertex.globalIndex,
          );
        } else {
          indices.push(
            strip[i].vertex.globalIndex,
            strip[i + 1].vertex.globalIndex,
            strip[i + 2].vertex.globalIndex,
          );
        }

        // Skip if any vertex is missing
        if (indices.some((idx) => idx === undefined)) continue;

        // Store material index for this triangle
        this.materialIndices.push(materialIndex);

        // Process vertex data for this triangle
        const triangleData = this.vertexList.getTriangleData(indices);

        // Add all data to the respective arrays
        this.vertices.push(...triangleData.positions);
        if (triangleData.normals.length > 0) {
          this.normals.push(...triangleData.normals);
        }
        this.colors.push(...triangleData.colors);
        this.uvs.push(...triangleData.uvs);

        // Add skinning data if available
        if (
          triangleData.skinIndices.length > 0 &&
          triangleData.skinWeights.length > 0
        ) {
          this.skinIndices.push(...triangleData.skinIndices);
          this.skinWeights.push(...triangleData.skinWeights);
        }
      }
    }

    this.reader.seek(expectedEnd);
    console.log("Strip end: ", this.reader.tellf());
  }

  getBones(): Bone[] {
    return this.bones;
  }

  getGeometry(): BufferGeometry {
    // Create geometry
    const geometry = new BufferGeometry();

    // Add vertex positions
    if (this.vertices.length > 0) {
      geometry.setAttribute(
        "position",
        new BufferAttribute(new Float32Array(this.vertices), 3),
      );
    }

    // Add normals if present
    if (this.normals.length > 0) {
      geometry.setAttribute(
        "normal",
        new BufferAttribute(new Float32Array(this.normals), 3),
      );
    }

    // Add colors
    if (this.colors.length > 0) {
      geometry.setAttribute(
        "color",
        new BufferAttribute(new Float32Array(this.colors), 4),
      );
    }

    // Add UVs
    if (this.uvs.length > 0) {
      geometry.setAttribute(
        "uv",
        new BufferAttribute(new Float32Array(this.uvs), 2),
      );
    }

    // Add skinning data
    if (this.skinIndices.length > 0 && this.skinWeights.length > 0) {
      geometry.setAttribute(
        "skinIndex",
        new BufferAttribute(new Float32Array(this.skinIndices), 4),
      );
      geometry.setAttribute(
        "skinWeight",
        new BufferAttribute(new Float32Array(this.skinWeights), 4),
      );
    }

    // Add a groups property to associate faces with materials
    const triangleCount = this.vertices.length / 9; // Each triangle has 3 vertices with x,y,z
    for (let i = 0; i < triangleCount; i++) {
      const materialIndex = this.materialIndices[i] || 0;
      geometry.addGroup(i * 3, 3, materialIndex);
    }

    return geometry;
  }

  getMaterials(): MaterialOptions[] {
    return this.materials;
  }

  getMaterialIndices(): number[] {
    return this.materialIndices;
  }
}

const readNjtl = (reader: ByteReader): string[] => {
  const ref = reader.tell();
  const ptr = reader.readUInt32();
  const count = reader.readUInt32();
  reader.seek(ptr + ref);

  const textureNamePointers: number[] = [];
  for (let i = 0; i < count; i++) {
    textureNamePointers.push(reader.readUInt32());
    reader.seekRel(8);
  }

  const textureNames: string[] = [];
  textureNamePointers.forEach((ptr) => {
    reader.seek(ref + ptr);
    const name = reader.readString();
    textureNames.push(name);
  });

  return textureNames;
};

interface ParsedNinjaModel {
  geometry?: BufferGeometry;
  textureNames?: string[];
  materials?: MaterialOptions[];
  materialIndices?: number[]; // Material index for each triangle/face
  bones?: Bone[];
  clips?: AnimationClip[];
}

type MotionItem = {
  posOffset: number;
  rotOffset: number;
  rotSmallOffset: number;
  sclOffset: number;
  quatOffset: number;
  posCount: number;
  rotCount: number;
  rotSmallCount: number;
  sclCount: number;
  quatCount: number;
};

const readAnimation = (reader: ByteReader, bones: Bone[], num: number) => {
  const motionOfs = reader.readUInt32();
  const nbFrame = reader.readUInt32();
  const motionType = reader.readUInt16();
  const motionFlag = reader.readUInt16();

  const duration = (nbFrame - 1) / 30;
  const motionList: MotionItem[] = [];
  const POS_BIT = 0x01;
  const ROT_BIT = 0x02;
  const ROT_SMALL_BIT = 0x20;
  const SCL_BIT = 0x04;
  const QUAT_BIT = 0x2000;

  reader.seek(motionOfs);
  for (let i = 0; i < bones.length; i++) {
    const item = {
      posOffset: 0,
      rotOffset: 0,
      rotSmallOffset: 0,
      sclOffset: 0,
      quatOffset: 0,
      posCount: 0,
      rotCount: 0,
      rotSmallCount: 0,
      sclCount: 0,
      quatCount: 0,
    };

    // First we read offsets
    if (motionType & POS_BIT) {
      item.posOffset = reader.readUInt32();
    }

    if (motionType & ROT_BIT) {
      item.rotOffset = reader.readUInt32();
    }

    if (motionType & ROT_SMALL_BIT) {
      item.rotSmallOffset = reader.readUInt32();
    }

    if (motionType & SCL_BIT) {
      item.sclOffset = reader.readUInt32();
    }

    if (motionType & QUAT_BIT) {
      item.quatOffset = reader.readUInt32();
    }

    // First we read counts
    if (motionType & POS_BIT) {
      item.posCount = reader.readUInt32();
    }

    if (motionType & ROT_BIT) {
      item.rotCount = reader.readUInt32();
    }

    if (motionType & ROT_SMALL_BIT) {
      item.rotSmallCount = reader.readUInt32();
    }

    if (motionType & SCL_BIT) {
      item.sclCount = reader.readUInt32();
    }

    if (motionType & QUAT_BIT) {
      item.quatCount = reader.readUInt32();
    }

    motionList.push(item);
  }

  const tracks: VectorKeyframeTrack | QuaternionKeyframeTrack[] = [];
  // Go through and read the position track values
  motionList.forEach(({ posOffset, posCount }, index) => {
    if (posCount === 0) {
      return;
    }

    const bone = bones[index];
    const name = `${bone.name}.position`;
    reader.seek(posOffset);
    const times: number[] = [];
    const positionValues: number[] = [];
    for (let i = 0; i < posCount; i++) {
      const time = reader.readUInt32() / 30;
      times.push(time);
      const x = reader.readFloat();
      const y = reader.readFloat();
      const z = reader.readFloat();
      positionValues.push(x, y, z);
    }

    const posTrack = new VectorKeyframeTrack(name, times, positionValues);
    tracks.push(posTrack);
  });

  // Go through and read the position track values
  motionList.forEach((item, index) => {
    const { rotCount, rotSmallCount, quatCount } = item;
    const { rotOffset, rotSmallOffset, quatOffset } = item;

    const bone = bones[index];
    const name = `${bone.name}.quaternion`;
    const times: number[] = [];
    const rotValues: number[] = [];
    if (rotCount) {
      reader.seek(rotOffset);
      for (let i = 0; i < rotCount; i++) {
        const time = reader.readUInt32() / 30;
        times.push(time);
        const x = reader.readInt32() * ((2 * Math.PI) / 0xffff);
        const y = reader.readInt32() * ((2 * Math.PI) / 0xffff);
        const z = reader.readInt32() * ((2 * Math.PI) / 0xffff);
        const euler = new Euler(x, y, z, "XYZ");
        const quat = new Quaternion().setFromEuler(euler);
        rotValues.push(quat.x, quat.y, quat.z, quat.w);
      }
    } else if (rotSmallCount) {
      reader.seek(rotSmallOffset);
      for (let i = 0; i < rotSmallCount; i++) {
        const time = reader.readInt16() / 30;
        times.push(time);
        const x = reader.readInt16() * ((2 * Math.PI) / 0xffff);
        const y = reader.readInt16() * ((2 * Math.PI) / 0xffff);
        const z = reader.readInt16() * ((2 * Math.PI) / 0xffff);
        const euler = new Euler(x, y, z, "XYZ");
        const quat = new Quaternion().setFromEuler(euler);
        rotValues.push(quat.x, quat.y, quat.z, quat.w);
      }
    } else if (quatCount) {
      reader.seek(quatOffset);
      for (let i = 0; i < quatCount; i++) {
        const time = reader.readUInt32() / 30;
        times.push(time);
        const w = reader.readFloat();
        const x = reader.readFloat();
        const y = reader.readFloat();
        const z = reader.readFloat();
        rotValues.push(x, y, z, w);
      }
    } else {
      return;
    }

    const rotTrack = new QuaternionKeyframeTrack(name, times, rotValues);
    tracks.push(rotTrack);
  });

  // Go through each of the scale tracks
  motionList.forEach(({ sclOffset, sclCount }, index) => {
    if (sclCount === 0) {
      return;
    }

    const bone = bones[index];
    const name = `${bone.name}.scale`;
    reader.seek(sclOffset);
    const times: number[] = [];
    const scaleValues: number[] = [];
    for (let i = 0; i < sclCount; i++) {
      const time = reader.readUInt32() / 30;
      times.push(time);
      const x = reader.readFloat();
      const y = reader.readFloat();
      const z = reader.readFloat();
      scaleValues.push(x, y, z);
    }

    const sclTrack = new VectorKeyframeTrack(name, times, scaleValues);
    tracks.push(sclTrack);
  });

  const clip = new AnimationClip(
    `anim_${num.toString().padStart(3, "0")}`,
    duration,
    tracks,
  );
  clip.optimize();
  return clip;
};

const parseNinjaModel = (buffer: ArrayBuffer): ParsedNinjaModel => {
  console.log("Parsing Ninja model");
  const reader = new ByteReader(buffer);
  reader.seekEnd(0);
  const end = reader.tell();
  reader.seek(0);

  const result: ParsedNinjaModel = {};

  do {
    const magic = reader.readString(4);
    const len = reader.readUInt32();
    const chunk = reader.getSlice(len);

    if (magic === "NJTL") {
      result.textureNames = readNjtl(chunk);
    } else if (magic === "NJCM") {
      const model = new NinjaModel(chunk);
      model.readBone();
      result.geometry = model.getGeometry();
      result.materials = model.getMaterials();
      result.materialIndices = model.getMaterialIndices();
      result.bones = model.getBones();
    } else if (magic === "NMDM") {
      if (!result.bones) {
        continue;
      }
      result.clips = result.clips || [];
      console.log("FOUND ANIMATION!!!!!", result.clips.length);
      try {
        const anim = readAnimation(chunk, result.bones, result.clips.length);
        result.clips.push(anim);
      } catch (err) {
        throw err;
      }
    } else if (magic === "POF0") {
      continue;
    } else {
      console.warn(`Unknown chunk type: ${magic}`);
      break;
    }
  } while (reader.tell() < end);

  return result;
};

export { parseNinjaModel, NinjaModel };
