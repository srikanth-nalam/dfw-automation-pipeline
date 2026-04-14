# Certificates

This directory holds TLS/SSL certificates required for vRO to communicate with
external systems over HTTPS. Certificates must be imported into the vRO trust
store before deploying the package.

## Required Certificates

| Certificate                   | Purpose                                    | Format   |
|-------------------------------|--------------------------------------------|----------|
| vcenter-ndcng-ca.pem         | vCenter NDCNG root CA certificate          | PEM      |
| vcenter-tulng-ca.pem         | vCenter TULNG root CA certificate          | PEM      |
| nsx-ndcng-ca.pem             | NSX-T Manager NDCNG root CA certificate    | PEM      |
| nsx-tulng-ca.pem             | NSX-T Manager TULNG root CA certificate    | PEM      |
| nsx-global-ndcng-ca.pem      | NSX Global Manager NDCNG root CA cert      | PEM      |
| nsx-global-tulng-ca.pem      | NSX Global Manager TULNG root CA cert      | PEM      |
| snow-ca.pem                  | ServiceNow instance root CA certificate    | PEM      |

## Import Procedure

1. Obtain certificates from the enterprise PKI team or export from the target system.
2. Verify the certificate chain: `openssl verify -CAfile ca-chain.pem cert.pem`
3. Import into the vRO trust store via the vRO Control Center:
   - Navigate to **Certificates** > **Import from file**
   - Upload each PEM file
   - Verify the imported certificate fingerprint
4. Restart the vRO service if prompted.

## Certificate Rotation

Certificates must be rotated before expiration. The enterprise PKI team publishes
rotation schedules. Monitor certificate expiration dates and plan rotations during
approved maintenance windows.

## Notes

- Certificate files are NOT included in this repository for security reasons.
- Contact the Infrastructure Security team for certificate provisioning.
- Certificates are environment-specific (dev, staging, production).
