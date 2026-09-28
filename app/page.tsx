import { redirect } from "next/navigation";

// The viewer lives at /pointcloud; the bare root just sends people there.
export default function Home() {
  redirect("/pointcloud");
}
