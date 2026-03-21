# End-to-End Data Flow

```mermaid
flowchart LR
    A[Tag Dictionary] -->|Reference values| B[Catalog Form]
    B -->|User input + validation| C[RITM Record]
    C -->|Approval workflow| D[Approved Request]
    D -->|REST POST| E[vRO Payload]
    E -->|Tag Operations| F[vCenter Tags]
    F -->|Auto-propagation| G[NSX Tags]
    G -->|Criteria evaluation| H[Dynamic Security Groups]
    H -->|Rule binding| I[DFW Policies Active]
    I -->|Callback| J[RITM Updated]
    J -->|Sync| K[CMDB CI Record]
```
