'use strict';

const MigrationVerifier = require('../../../src/vro/actions/lifecycle/MigrationVerifier');

describe('MigrationVerifier', () => {
  let verifier;
  let deps;

  beforeEach(() => {
    deps = {
      tagOperations: {
        getTags: jest.fn().mockResolvedValue({
          Region: 'NDCNG',
          SecurityZone: 'Greenzone',
          Environment: 'Production',
          AppCI: 'APP001',
          SystemRole: 'Web'
        }),
        applyTags: jest.fn().mockResolvedValue({ applied: true }),
        verifyPropagation: jest.fn().mockResolvedValue({ propagated: true })
      },
      groupVerifier: {
        verifyMembership: jest.fn().mockResolvedValue({ verified: true, groups: ['SG-Web-Production'] })
      },
      restClient: {
        post: jest.fn().mockResolvedValue({ status: 200 })
      },
      logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn()
      },
      configLoader: {
        getEndpointsForSite: jest.fn().mockReturnValue({
          vcenterUrl: 'https://vcenter-tulng.test',
          nsxUrl: 'https://nsx-tulng.test'
        })
      },
      snowAdapter: {
        toCallbackPayload: jest.fn().mockImplementation(r => r)
      }
    };

    verifier = new MigrationVerifier(deps);
  });

  const buildPayload = (overrides = {}) => ({
    correlationId: 'MIG-001',
    vmId: 'vm-migrate-001',
    vmName: 'NDCNG-APP001-WEB-P01',
    sourceSite: 'NDCNG',
    destinationSite: 'TULNG',
    expectedTags: {
      Region: 'NDCNG',
      SecurityZone: 'Greenzone',
      Environment: 'Production',
      AppCI: 'APP001',
      SystemRole: 'Web'
    },
    callbackUrl: 'https://snow.test/callback',
    ...overrides
  });

  // Constructor
  test('throws when dependencies is null', () => {
    expect(() => new MigrationVerifier(null)).toThrow(/DFW-8500/);
  });

  // Tags preserved
  test('reports tags preserved when destination matches expected', async () => {
    const result = await verifier.verifyPostMigration(buildPayload());

    expect(result.tagsPreserved).toBe(true);
    expect(Object.keys(result.missingTags)).toHaveLength(0);
    expect(result.reapplied).toBe(false);
  });

  // Tags missing
  test('detects and re-applies missing tags', async () => {
    deps.tagOperations.getTags.mockResolvedValue({
      AppCI: 'APP001'
      // Missing Region, SecurityZone, Environment, SystemRole
    });

    const result = await verifier.verifyPostMigration(buildPayload());

    expect(result.tagsPreserved).toBe(false);
    expect(result.missingTags).toHaveProperty('SystemRole');
    expect(result.missingTags).toHaveProperty('Environment');
    expect(result.reapplied).toBe(true);
    expect(deps.tagOperations.applyTags).toHaveBeenCalled();
  });

  // Re-apply failure
  test('handles tag re-apply failure gracefully', async () => {
    deps.tagOperations.getTags.mockResolvedValue({});
    deps.tagOperations.applyTags.mockRejectedValue(new Error('NSX error'));

    const result = await verifier.verifyPostMigration(buildPayload());

    expect(result.tagsPreserved).toBe(false);
    expect(result.reapplied).toBe(false);
    expect(deps.logger.error).toHaveBeenCalled();
  });

  // Group verification
  test('verifies group membership at destination', async () => {
    const result = await verifier.verifyPostMigration(buildPayload());

    expect(result.groupMembershipVerified).toBe(true);
    expect(deps.groupVerifier.verifyMembership).toHaveBeenCalledWith(
      'vm-migrate-001', 'TULNG'
    );
  });

  // Group verification failure
  test('handles group verification failure', async () => {
    deps.groupVerifier.verifyMembership.mockRejectedValue(new Error('Group check failed'));

    const result = await verifier.verifyPostMigration(buildPayload());

    expect(result.groupMembershipVerified).toBe(false);
  });

  // Callback
  test('sends callback to ServiceNow', async () => {
    await verifier.verifyPostMigration(buildPayload());

    expect(deps.restClient.post).toHaveBeenCalledWith(
      'https://snow.test/callback',
      expect.objectContaining({
        correlationId: 'MIG-001',
        vmId: 'vm-migrate-001'
      })
    );
  });

  // Result structure
  test('result contains all required fields', async () => {
    const result = await verifier.verifyPostMigration(buildPayload());

    expect(result).toHaveProperty('correlationId');
    expect(result).toHaveProperty('vmId');
    expect(result).toHaveProperty('vmName');
    expect(result).toHaveProperty('sourceSite');
    expect(result).toHaveProperty('destinationSite');
    expect(result).toHaveProperty('tagsPreserved');
    expect(result).toHaveProperty('missingTags');
    expect(result).toHaveProperty('reapplied');
    expect(result).toHaveProperty('groupMembershipVerified');
    expect(result).toHaveProperty('verificationTimestamp');
  });

  // Error propagation
  test('throws when tag retrieval fails', async () => {
    deps.tagOperations.getTags.mockRejectedValue(new Error('Connection refused'));

    await expect(verifier.verifyPostMigration(buildPayload()))
      .rejects.toThrow('Connection refused');
  });
});
