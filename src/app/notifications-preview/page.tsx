import type { Metadata } from "next";
import NotificationPreview from "./notification-preview";

export const metadata: Metadata = {
  title: "Notifications · QuizTime Design Preview",
  description:
    "An interactive notification concept with sample data. No notifications are sent.",
  robots: "noindex, nofollow",
};

export default function NotificationsPreviewPage() {
  return <NotificationPreview />;
}
