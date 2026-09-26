"use client";

import { useState } from "react";

import { WorkspacePicker } from "@/app/ens/_components/WorkspacePicker";
import { Field, Input } from "@/app/ens/_components/ui";
import { tryNormalize } from "@/app/ens/_lib/ens/names";

import { AccessControlCard } from "./AccessControlCard";
import { LookupCard } from "./LookupCard";
import { ManageNameCard } from "./ManageNameCard";
import { PrimaryNameCard } from "./PrimaryNameCard";
import { PublishTreeCard } from "./PublishTreeCard";
import { RegisterCard } from "./RegisterCard";
import { SetupCard } from "./SetupCard";
import { SubnamesCard } from "./SubnamesCard";

export function Playground() {
  const [nameInput, setNameInput] = useState("");
  const normalized = tryNormalize(nameInput);
  const name = normalized && normalized.includes(".") ? normalized : null;

  return (
    <div className="flex flex-col gap-6">
      <SetupCard />
      <RegisterCard onRegistered={setNameInput} />

      <div className="sticky top-14 z-10 rounded-xl border border-sky-200 bg-sky-50/95 p-4 backdrop-blur dark:border-sky-900 dark:bg-sky-950/90">
        <Field label="Working on name (used by sections 3–6)">
          <Input value={nameInput} onChange={(e) => setNameInput(e.target.value)} placeholder="myname.eth or sub.myname.eth" className="max-w-md" />
        </Field>
        <div className="mt-2">
          <WorkspacePicker kind="names" onPick={setNameInput} />
        </div>
      </div>

      <ManageNameCard name={name} />
      <SubnamesCard name={name} onSelect={setNameInput} />
      <AccessControlCard name={name} />
      <PrimaryNameCard name={name} />
      <LookupCard />
      <PublishTreeCard onSelect={setNameInput} />
    </div>
  );
}
