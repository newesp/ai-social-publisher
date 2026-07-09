import { AppShellFrame } from "../../components/AppShellFrame.js";
import { SettingsPanel } from "../../components/SettingsPanel.js";

export default function SettingsPage() {
  return (
    <AppShellFrame active="settings">
      <SettingsPanel />
    </AppShellFrame>
  );
}
