import { AppShellFrame } from "../components/AppShellFrame.js";
import { CreatePostWizard } from "../components/CreatePostWizard.js";

export default function HomePage() {
  return (
    <AppShellFrame active="create">
      <CreatePostWizard />
    </AppShellFrame>
  );
}
