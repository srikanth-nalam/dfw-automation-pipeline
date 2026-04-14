# Phantom VM Detection Sequence

Sequence diagram for `PhantomVMDetector.detect()`. Compares the NSX fabric
VM inventory against vCenter to identify phantom VMs (present in NSX but
absent from vCenter) and optionally cleans up their stale tags.

```mermaid
sequenceDiagram
    participant Caller
    participant PVD as PhantomVMDetector
    participant NSX as NSX Manager
    participant VC as vCenter
    participant TO as TagOperations

    Caller->>PVD: detect(site)
    PVD->>NSX: GET /api/v1/fabric/virtual-machines
    NSX-->>PVD: nsxVMs[]
    PVD->>VC: GET /api/vcenter/vm
    VC-->>PVD: vcenterVMs[]
    PVD->>PVD: phantoms = nsxSet - vcenterSet
    loop Each phantom VM
        PVD->>TO: getCurrentTags(vmId)
        TO-->>PVD: tags
        opt cleanupTags
            PVD->>TO: removeTags(vmId)
        end
    end
    PVD-->>Caller: { phantomVMs, cleanedUp }
```
