/**
 * agyloop - Ecosystem Value Object
 *
 * Immutable, self-validating value object representing a detected software ecosystem.
 */

import {
  SUPPORTED_ECOSYSTEMS,
  EcosystemType,
  ECOSYSTEM_NODE,
  ECOSYSTEM_PYTHON,
  ECOSYSTEM_GO,
  ECOSYSTEM_RUST,
  ECOSYSTEM_GRADLE,
  ECOSYSTEM_MAVEN,
  ECOSYSTEM_DOTNET,
  ECOSYSTEM_UNKNOWN,
  PackageManagerName,
  DEFAULT_ECOSYSTEM_PRIORITY,
  FALLBACK_ECOSYSTEM_PRIORITY,
  CONFIDENCE_CERTAIN,
  CONFIDENCE_NONE
} from '../constants';
import { ValidationError } from '../errors';

export interface EcosystemProps {
  readonly type: EcosystemType | string;
  readonly markerFiles?: readonly string[];
  readonly packageManager?: PackageManagerName | string | null;
  readonly confidence?: number;
  readonly priority?: number;
}

export class Ecosystem {
  public readonly type: EcosystemType;
  public readonly markerFiles: readonly string[];
  public readonly packageManager: PackageManagerName | string | null;
  public readonly confidence: number;
  public readonly priority: number;

  constructor(props: EcosystemProps) {
    if (!props || typeof props !== 'object') {
      throw new ValidationError('ecosystem', props, 'Ecosystem properties must be provided as an object.');
    }

    const rawType = String(props.type || '').trim().toLowerCase() as EcosystemType;
    if (!(SUPPORTED_ECOSYSTEMS as readonly string[]).includes(rawType)) {
      const valid = SUPPORTED_ECOSYSTEMS.join(', ');
      throw new ValidationError('type', props.type, `Unsupported ecosystem '${props.type}'. Supported ecosystems: ${valid}.`);
    }

    const markers = props.markerFiles ? [...props.markerFiles] : [];
    for (const marker of markers) {
      if (typeof marker !== 'string' || marker.trim().length === 0) {
        throw new ValidationError('markerFiles', marker, 'Each marker file must be a non-empty string.');
      }
    }

    const confidence = props.confidence !== undefined ? props.confidence : CONFIDENCE_CERTAIN;
    if (typeof confidence !== 'number' || isNaN(confidence) || confidence < CONFIDENCE_NONE || confidence > CONFIDENCE_CERTAIN) {
      throw new ValidationError('confidence', confidence, 'Ecosystem confidence must be a number between 0 and 1.');
    }

    const priority = props.priority !== undefined ? props.priority : DEFAULT_ECOSYSTEM_PRIORITY;
    if (typeof priority !== 'number' || isNaN(priority)) {
      throw new ValidationError('priority', priority, 'Ecosystem priority must be a valid number.');
    }

    this.type = rawType;
    this.markerFiles = Object.freeze(markers.map((m) => m.trim()));
    this.packageManager = props.packageManager ? String(props.packageManager).trim() : null;
    this.confidence = confidence;
    this.priority = priority;

    Object.freeze(this);
  }

  public hasMarker(marker: string): boolean {
    if (!marker) return false;
    return this.markerFiles.includes(marker.trim());
  }

  public isNode(): boolean {
    return this.type === ECOSYSTEM_NODE;
  }

  public isGo(): boolean {
    return this.type === ECOSYSTEM_GO;
  }

  public isRust(): boolean {
    return this.type === ECOSYSTEM_RUST;
  }

  public isPython(): boolean {
    return this.type === ECOSYSTEM_PYTHON;
  }

  public isGradle(): boolean {
    return this.type === ECOSYSTEM_GRADLE;
  }

  public isMaven(): boolean {
    return this.type === ECOSYSTEM_MAVEN;
  }

  public isDotnet(): boolean {
    return this.type === ECOSYSTEM_DOTNET;
  }

  public isUnknown(): boolean {
    return this.type === ECOSYSTEM_UNKNOWN;
  }

  public equals(other?: Ecosystem | null): boolean {
    if (!other) return false;
    return (
      this.type === other.type &&
      this.packageManager === other.packageManager &&
      this.markerFiles.length === other.markerFiles.length &&
      this.markerFiles.every((m, idx) => m === other.markerFiles[idx])
    );
  }

  public toString(): string {
    if (this.packageManager) {
      return `${this.type} (${this.packageManager})`;
    }
    return this.type;
  }

  public static create(props: EcosystemProps): Ecosystem {
    return new Ecosystem(props);
  }

  public static unknown(): Ecosystem {
    return new Ecosystem({
      type: ECOSYSTEM_UNKNOWN,
      markerFiles: [],
      confidence: CONFIDENCE_NONE,
      priority: FALLBACK_ECOSYSTEM_PRIORITY
    });
  }
}
