import { describe, it, expect } from 'vitest';
import { CreateDeploymentSchema, UpdateDeploymentSchema } from '../routes/validation.js';

describe('CreateDeploymentSchema', () => {
  const validInput = {
    name: 'my-deployment',
    providerSlug: 'provider-a',
    gpuModel: 'A100',
    gpuVramGb: 80,
    gpuCount: 2,
    artifactType: 'ai-runner',
    artifactVersion: 'v0.14.1',
    dockerImage: 'livepeer/ai-runner:v0.14.1',
  };

  it('should pass with valid complete input', () => {
    const result = CreateDeploymentSchema.safeParse(validInput);
    expect(result.success).toBe(true);
  });

  it('should pass with all optional fields included', () => {
    const result = CreateDeploymentSchema.safeParse({
      ...validInput,
      cudaVersion: '12.1',
      healthPort: 8080,
      healthEndpoint: '/health',
      artifactConfig: { pipeline: 'txt2img' },
      sshHost: '192.168.1.1',
      sshPort: 22,
      sshUsername: 'deploy',
      containerName: 'runner-1',
      templateId: 'ai-runner',
    });
    expect(result.success).toBe(true);
  });

  it('should fail when name is missing', () => {
    const { name, ...rest } = validInput;
    const result = CreateDeploymentSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it('should fail when name is empty string', () => {
    const result = CreateDeploymentSchema.safeParse({ ...validInput, name: '' });
    expect(result.success).toBe(false);
  });

  it('should fail when name starts with a hyphen', () => {
    const result = CreateDeploymentSchema.safeParse({ ...validInput, name: '-bad-name' });
    expect(result.success).toBe(false);
  });

  it('should fail when name starts with a dot', () => {
    const result = CreateDeploymentSchema.safeParse({ ...validInput, name: '.dotname' });
    expect(result.success).toBe(false);
  });

  it('should pass when name starts with alphanumeric', () => {
    const r1 = CreateDeploymentSchema.safeParse({ ...validInput, name: 'a-valid-name' });
    expect(r1.success).toBe(true);

    const r2 = CreateDeploymentSchema.safeParse({ ...validInput, name: '0starts-with-digit' });
    expect(r2.success).toBe(true);
  });

  it('should allow dots, hyphens, and underscores in name', () => {
    const result = CreateDeploymentSchema.safeParse({ ...validInput, name: 'my.deploy_v1-test' });
    expect(result.success).toBe(true);
  });

  it('should default gpuCount to 1 when not provided', () => {
    const { gpuCount, ...rest } = validInput;
    const result = CreateDeploymentSchema.safeParse(rest);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.gpuCount).toBe(1);
    }
  });

  it('should fail when gpuCount exceeds 8', () => {
    const result = CreateDeploymentSchema.safeParse({ ...validInput, gpuCount: 9 });
    expect(result.success).toBe(false);
  });

  it('should fail when gpuCount is 0', () => {
    const result = CreateDeploymentSchema.safeParse({ ...validInput, gpuCount: 0 });
    expect(result.success).toBe(false);
  });

  it('should fail when gpuVramGb is 0 or negative', () => {
    const r1 = CreateDeploymentSchema.safeParse({ ...validInput, gpuVramGb: 0 });
    expect(r1.success).toBe(false);

    const r2 = CreateDeploymentSchema.safeParse({ ...validInput, gpuVramGb: -1 });
    expect(r2.success).toBe(false);
  });

  it('should accept healthPort in range 1-65535', () => {
    const r1 = CreateDeploymentSchema.safeParse({ ...validInput, healthPort: 1 });
    expect(r1.success).toBe(true);

    const r2 = CreateDeploymentSchema.safeParse({ ...validInput, healthPort: 65535 });
    expect(r2.success).toBe(true);
  });

  it('should reject healthPort outside range 1-65535', () => {
    const r1 = CreateDeploymentSchema.safeParse({ ...validInput, healthPort: 0 });
    expect(r1.success).toBe(false);

    const r2 = CreateDeploymentSchema.safeParse({ ...validInput, healthPort: 65536 });
    expect(r2.success).toBe(false);
  });

  it('should fail when gpuVramGb is a float', () => {
    const result = CreateDeploymentSchema.safeParse({ ...validInput, gpuVramGb: 24.5 });
    expect(result.success).toBe(false);
  });

  it('should fail when name exceeds 64 characters', () => {
    const result = CreateDeploymentSchema.safeParse({
      ...validInput,
      name: 'a'.repeat(65),
    });
    expect(result.success).toBe(false);
  });
});

describe('UpdateDeploymentSchema', () => {
  it('should accept partial updates', () => {
    const result = UpdateDeploymentSchema.safeParse({ artifactVersion: 'v2.0.0' });
    expect(result.success).toBe(true);
  });

  it('should accept empty object (no fields required)', () => {
    const result = UpdateDeploymentSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('should accept all update fields', () => {
    const result = UpdateDeploymentSchema.safeParse({
      artifactVersion: 'v2.0.0',
      dockerImage: 'livepeer/ai-runner:v2.0.0',
      gpuModel: 'H100',
      gpuVramGb: 80,
      gpuCount: 4,
      artifactConfig: { pipeline: 'img2vid' },
    });
    expect(result.success).toBe(true);
  });

  it('should reject invalid gpuCount (> 8)', () => {
    const result = UpdateDeploymentSchema.safeParse({ gpuCount: 10 });
    expect(result.success).toBe(false);
  });

  it('should reject gpuCount of 0', () => {
    const result = UpdateDeploymentSchema.safeParse({ gpuCount: 0 });
    expect(result.success).toBe(false);
  });

  it('should reject gpuVramGb less than 1', () => {
    const result = UpdateDeploymentSchema.safeParse({ gpuVramGb: 0 });
    expect(result.success).toBe(false);
  });

  it('should reject non-integer gpuVramGb', () => {
    const result = UpdateDeploymentSchema.safeParse({ gpuVramGb: 12.5 });
    expect(result.success).toBe(false);
  });
});
