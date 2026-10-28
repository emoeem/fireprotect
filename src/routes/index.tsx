import { createFileRoute } from "@tanstack/react-router";
import { Workshop } from "@/components/workshop";

export const Route = createFileRoute("/")({ component: Workshop });
