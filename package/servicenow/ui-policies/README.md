# UI Policies — DFW Automation Catalog Items

UI Policy definitions that control conditional field visibility, mandatory status,
read-only flags, and default values based on form state.

## Policies

| Policy                                    | Catalog Item         | Condition                                     |
|-------------------------------------------|----------------------|-----------------------------------------------|
| Show Compliance Fields for Restricted     | VM Build Request     | SecurityZone = Restricted                     |
| Require Change Control for Production     | Tag Update Request   | Environment = Production or Pre-Production    |
| Show Source App Fields                    | Rule Request         | Source Group = Application-Specific Group     |
| Show Destination App Fields              | Rule Request         | Destination Group = Application-Specific Group|
| Show Existing Rule Field                 | Rule Request         | Action = Modify, Renew, or Deactivate        |
| Hide VM Specs for Tag Update             | Tag Update Request   | Always (hide CPU, Memory, Disk fields)        |
| Show Target Fields for Category Update   | Bulk Tag Request     | Operation Type = Update Category              |
| Require Security Architect Approval      | Tag Update Request   | SecurityZone changed                          |

## Source

All UI policy definitions are maintained in:
`src/servicenow/catalog/ui-policies/conditionalFieldPolicies.js`

## How It Works

Each UI policy object contains:

- **condition** — ServiceNow condition string (`field^operator^value` format)
- **reverseCondition** — Whether to reverse actions when the condition becomes false
- **onLoad** — Whether to execute on form load
- **order** — Execution priority (lower = earlier)
- **actions** — Field-level actions (visible, mandatory, read-only, value)

## Deployment

UI policies are included in the Update Set (`update-set.xml`). They can also
be deployed individually via the ServiceNow REST API or the ServiceNow Studio IDE.
