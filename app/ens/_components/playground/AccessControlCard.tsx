"use client";

import { useState } from "react";
import { type Address, encodeFunctionData, isAddress, parseAbi } from "viem";
import { useReadContracts, useWriteContract } from "wagmi";

import { TxButton, TxStatus } from "@/app/ens/_components/Tx";
import { AddressLink, Badge, Button, Card, Field, Input, Notice, Row, Select } from "@/app/ens/_components/ui";
import { PermissionedResolverImplAbi } from "@/app/ens/_lib/ens/abis/PermissionedResolverImpl";
import {
  type Group,
  type Policy,
  PRESET_POLICIES,
  TARGETS,
  type Target,
  canDelegate,
  describePolicy,
  describeRoles,
  policyBitmap,
  textKeyResource,
} from "@/app/ens/_lib/ens/access";
import { ROOT_RESOURCE, ResolverRoles } from "@/app/ens/_lib/ens/roles";
import { useLocalJson } from "@/app/ens/_lib/hooks/useLocalJson";
import { useMyResolver } from "@/app/ens/_lib/hooks/useMyResolver";
import { useNameInfo } from "@/app/ens/_lib/hooks/useNameInfo";
import { useTx } from "@/app/ens/_lib/hooks/useTx";
import { CHAIN_ID } from "@/app/ens/_lib/wagmi";

// The Enhanced Access Control functions shared by registries and resolvers.
const eacAbi = parseAbi([
  "function roles(uint256 resource, address account) view returns (uint256)",
  "function grantRoles(uint256 resource, uint256 roleBitmap, address account) returns (bool)",
  "function revokeRoles(uint256 resource, uint256 roleBitmap, address account) returns (bool)",
  "function grantRootRoles(uint256 roleBitmap, address account) returns (bool)",
  "function revokeRootRoles(uint256 roleBitmap, address account) returns (bool)",
]);

const NO_GROUPS: Group[] = [];
const NO_POLICIES: Policy[] = [];

export function AccessControlCard({ name }: { name: string | null }) {
  const [groups, setGroups] = useLocalJson<Group[]>("ensv2:groups", NO_GROUPS);
  const [custom, setCustom] = useLocalJson<Policy[]>("ensv2:policies", NO_POLICIES);
  const policies = [...PRESET_POLICIES, ...custom];

  return (
    <Card
      title="5. Access control"
      description="Create policies (sets of permissions) and groups (lists of addresses), then grant a policy to a group. Policies and groups are saved in this browser; granting writes the roles on-chain, one transaction per member."
    >
      <div className="grid gap-6 lg:grid-cols-2">
        <Policies policies={policies} onSave={(p) => setCustom([...custom, p])} onDelete={(id) => setCustom(custom.filter((p) => p.id !== id))} />
        <Groups groups={groups} setGroups={setGroups} />
      </div>
      <Apply name={name} policies={policies} groups={groups} />
    </Card>
  );
}

function Policies({ policies, onSave, onDelete }: { policies: Policy[]; onSave: (p: Policy) => void; onDelete: (id: string) => void }) {
  const [policyName, setPolicyName] = useState("");
  const [target, setTarget] = useState<Target>("resolver");
  const [roles, setRoles] = useState(0n);
  const [delegate, setDelegate] = useState(false);
  const [textKey, setTextKey] = useState("");
  const scoped = target === "resolver" && textKey.trim() !== "";
  const effectiveRoles = scoped ? ResolverRoles.ROLE_SET_TEXT : roles;

  const save = () => {
    onSave({
      id: crypto.randomUUID(),
      name: policyName.trim(),
      target,
      roles: effectiveRoles.toString(),
      delegate: canDelegate(target, scoped ? textKey : undefined) && delegate,
      textKey: scoped ? textKey.trim() : undefined,
    });
    setPolicyName("");
    setRoles(0n);
    setDelegate(false);
    setTextKey("");
  };

  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-sm font-semibold">Policies</h3>
      <ul className="flex flex-col gap-1.5 text-sm">
        {policies.map((p) => (
          <li key={p.id} className="flex items-start justify-between gap-2 rounded-md border border-zinc-200 px-3 py-2 dark:border-zinc-800">
            <div>
              <div className="font-medium">
                {p.name} <Badge>{TARGETS[p.target].label}</Badge>
              </div>
              <div className="text-xs text-zinc-500">{describePolicy(p)}</div>
            </div>
            {!p.builtin && (
              <button type="button" onClick={() => onDelete(p.id)} className="text-xs text-zinc-400 hover:text-red-500">
                delete
              </button>
            )}
          </li>
        ))}
      </ul>
      <div className="flex flex-col gap-2 rounded-md bg-zinc-50 p-3 dark:bg-zinc-900">
        <div className="text-xs font-semibold uppercase text-zinc-500">New policy</div>
        <Row>
          <Input value={policyName} onChange={(e) => setPolicyName(e.target.value)} placeholder="Policy name" className="w-44" />
          <Select
            value={target}
            onChange={(e) => {
              setTarget(e.target.value as Target);
              setRoles(0n);
            }}
            className="w-56"
          >
            {(Object.keys(TARGETS) as Target[]).map((t) => (
              <option key={t} value={t}>
                {TARGETS[t].label}
              </option>
            ))}
          </Select>
        </Row>
        <p className="text-xs text-zinc-500">{TARGETS[target].description}</p>
        <div className="grid grid-cols-2 gap-1 text-sm">
          {TARGETS[target].permissions.map((perm) => (
            <label key={perm.label} className={`flex items-center gap-2 ${scoped ? "opacity-50" : ""}`}>
              <input
                type="checkbox"
                disabled={scoped}
                checked={(effectiveRoles & perm.value) !== 0n}
                onChange={(e) => setRoles(e.target.checked ? roles | perm.value : roles & ~perm.value)}
              />
              {perm.label}
            </label>
          ))}
        </div>
        {target === "resolver" && (
          <Field label="Limit to one text record (optional)" hint='e.g. "avatar": the grantee can only set that key'>
            <Input value={textKey} onChange={(e) => setTextKey(e.target.value)} placeholder="text key" className="w-44" />
          </Field>
        )}
        {canDelegate(target, scoped ? textKey : undefined) && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={delegate} onChange={(e) => setDelegate(e.target.checked)} />
            Grantees can pass these permissions on to others
          </label>
        )}
        <Button onClick={save} disabled={!policyName.trim() || effectiveRoles === 0n} className="self-start">
          Save policy
        </Button>
      </div>
    </div>
  );
}

function Groups({ groups, setGroups }: { groups: Group[]; setGroups: (g: Group[]) => void }) {
  const [groupName, setGroupName] = useState("");
  const [memberInputs, setMemberInputs] = useState<Record<string, string>>({});

  const update = (id: string, fn: (g: Group) => Group) => setGroups(groups.map((g) => (g.id === id ? fn(g) : g)));

  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-sm font-semibold">Groups</h3>
      {groups.length === 0 && <p className="text-sm text-zinc-500">No groups yet.</p>}
      <ul className="flex flex-col gap-2">
        {groups.map((g) => {
          const input = memberInputs[g.id] ?? "";
          return (
            <li key={g.id} className="flex flex-col gap-2 rounded-md border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800">
              <div className="flex items-center justify-between">
                <span className="font-medium">
                  {g.name} <span className="text-zinc-500">({g.members.length})</span>
                </span>
                <button type="button" onClick={() => setGroups(groups.filter((x) => x.id !== g.id))} className="text-xs text-zinc-400 hover:text-red-500">
                  delete
                </button>
              </div>
              {g.members.map((m) => (
                <div key={m} className="flex items-center gap-2 text-xs">
                  <AddressLink address={m} />
                  <button type="button" onClick={() => update(g.id, (x) => ({ ...x, members: x.members.filter((y) => y !== m) }))} className="text-zinc-400 hover:text-red-500">
                    ×
                  </button>
                </div>
              ))}
              <Row>
                <Input value={input} onChange={(e) => setMemberInputs({ ...memberInputs, [g.id]: e.target.value })} placeholder="0x… member address" className="flex-1" />
                <Button
                  variant="secondary"
                  disabled={!isAddress(input) || g.members.some((m) => m.toLowerCase() === input.toLowerCase())}
                  onClick={() => {
                    update(g.id, (x) => ({ ...x, members: [...x.members, input as Address] }));
                    setMemberInputs({ ...memberInputs, [g.id]: "" });
                  }}
                >
                  Add
                </Button>
              </Row>
            </li>
          );
        })}
      </ul>
      <Row>
        <Input value={groupName} onChange={(e) => setGroupName(e.target.value)} placeholder="New group name, e.g. Editors" className="flex-1" />
        <Button
          disabled={!groupName.trim()}
          onClick={() => {
            setGroups([...groups, { id: crypto.randomUUID(), name: groupName.trim(), members: [] }]);
            setGroupName("");
          }}
        >
          Create group
        </Button>
      </Row>
    </div>
  );
}

function Apply({ name, policies, groups }: { name: string | null; policies: Policy[]; groups: Group[] }) {
  const info = useNameInfo(name);
  const my = useMyResolver();
  const { mutateAsync } = useWriteContract();
  const tx = useTx();

  const [policyId, setPolicyId] = useState(PRESET_POLICIES[0].id);
  const [who, setWho] = useState("address");
  const [single, setSingle] = useState("");
  const [progress, setProgress] = useState<string | null>(null);

  const policy = policies.find((p) => p.id === policyId) ?? policies[0];
  const group = groups.find((g) => g.id === who);
  const members: Address[] = group ? group.members : isAddress(single) ? [single] : [];

  // Resolve the policy's target to a concrete contract + EAC resource.
  let contract: Address | undefined;
  let resource: bigint | undefined;
  let unavailable = "";
  if (policy.target === "name") {
    if (!name || !info.active || !info.registry || !info.state) unavailable = "Pick a registered name above.";
    else {
      contract = info.registry;
      resource = info.state.resource;
    }
  } else if (policy.target === "resolver") {
    if (!my.deployed || !my.resolver) unavailable = "Deploy your resolver first (step 1).";
    else {
      contract = my.resolver;
      resource = policy.textKey ? textKeyResource(policy.textKey) : ROOT_RESOURCE;
    }
  } else {
    if (!name || !info.subregistry) unavailable = "The selected name has no subname registry yet (step 4).";
    else {
      contract = info.subregistry;
      resource = ROOT_RESOURCE;
    }
  }

  const current = useReadContracts({
    contracts: members.map((m) => ({
      address: contract,
      abi: eacAbi,
      functionName: "roles" as const,
      args: [resource ?? 0n, m] as const,
      chainId: CHAIN_ID,
    })),
    query: { enabled: !!contract && resource !== undefined && members.length > 0 },
  });

  const send = async (grant: boolean) => {
    if (!contract || resource === undefined) return;
    const bitmap = policyBitmap(policy);
    for (const [i, m] of members.entries()) {
      setProgress(`${grant ? "Granting" : "Revoking"} ${i + 1}/${members.length}`);
      const r = await tx.run(() => {
        if (policy.target === "resolver" && policy.textKey) {
          if (grant) {
            // grantSetterRoles derives the key-scoped resource from an encoded setter call;
            // only the selector and the key matter, so the name and value are placeholders.
            const setter = encodeFunctionData({
              abi: PermissionedResolverImplAbi,
              functionName: "setText",
              args: ["0x00", policy.textKey, ""],
            });
            return mutateAsync({ address: contract, abi: PermissionedResolverImplAbi, functionName: "grantSetterRoles", args: [setter, m], chainId: CHAIN_ID });
          }
          return mutateAsync({ address: contract, abi: eacAbi, functionName: "revokeRoles", args: [resource, bitmap, m], chainId: CHAIN_ID });
        }
        if (policy.target === "name") {
          return mutateAsync({ address: contract, abi: eacAbi, functionName: grant ? "grantRoles" : "revokeRoles", args: [resource, bitmap, m], chainId: CHAIN_ID });
        }
        return mutateAsync({ address: contract, abi: eacAbi, functionName: grant ? "grantRootRoles" : "revokeRootRoles", args: [bitmap, m], chainId: CHAIN_ID });
      });
      if (!r) break;
    }
    setProgress(null);
    current.refetch();
    if (policy.target === "name") info.refetch();
  };

  return (
    <div className="flex flex-col gap-3 border-t border-zinc-200 pt-4 dark:border-zinc-800">
      <h3 className="text-sm font-semibold">Grant or revoke</h3>
      <Row>
        <Field label="Policy">
          <Select value={policy.id} onChange={(e) => setPolicyId(e.target.value)} className="w-56">
            {policies.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="To">
          <Select value={who} onChange={(e) => setWho(e.target.value)} className="w-56">
            <option value="address">A single address</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                Group: {g.name} ({g.members.length})
              </option>
            ))}
          </Select>
        </Field>
        {!group && (
          <Field label="Address">
            <Input value={single} onChange={(e) => setSingle(e.target.value)} placeholder="0x…" className="w-96" />
          </Field>
        )}
      </Row>
      <p className="text-sm text-zinc-500">
        On: {TARGETS[policy.target].label}
        {policy.target !== "resolver" && name ? ` (${name})` : ""}
        {contract && (
          <>
            {" "}
            · <AddressLink address={contract} short />
          </>
        )}
        {" "}· {describePolicy(policy)}
      </p>
      {unavailable && <Notice tone="warning">{unavailable}</Notice>}
      {policy.target === "name" && !unavailable && !info.isOwner && (
        <Notice tone="info">You don&apos;t own {name}; this only works if its owner let you delegate these roles.</Notice>
      )}
      <Row>
        <TxButton tx={tx} onClick={() => send(true)} disabled={!contract || members.length === 0}>
          Grant to {members.length} {members.length === 1 ? "address" : "addresses"}
        </TxButton>
        <TxButton tx={tx} variant="secondary" onClick={() => send(false)} disabled={!contract || members.length === 0}>
          Revoke
        </TxButton>
        {progress && <span className="text-sm text-zinc-500">{progress}</span>}
      </Row>
      {members.length > 0 && contract && (
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-zinc-500">
            <tr>
              <th className="py-1 pr-4 font-medium">Member</th>
              <th className="py-1 font-medium">Current permissions here</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m, i) => {
              const bitmap = current.data?.[i]?.result as bigint | undefined;
              const perms = bitmap === undefined ? null : describeRoles(policy.target, bitmap);
              return (
                <tr key={m} className="border-t border-zinc-100 dark:border-zinc-900">
                  <td className="py-1 pr-4">
                    <AddressLink address={m} short />
                  </td>
                  <td className="py-1 text-xs">
                    {perms === null ? "…" : perms.length ? perms.join(", ") + (policy.textKey ? ` (key "${policy.textKey}")` : "") : "none"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {policy.target === "name" && (
        <p className="text-xs text-zinc-500">
          Note: granting or revoking roles on a name changes its token ID, and safe transfers are blocked while other accounts hold roles on it.
        </p>
      )}
      <TxStatus tx={tx} />
    </div>
  );
}
