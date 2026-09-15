import * as React from "react";
import { Badge, Button, Mono, Panel, PanelBody, PanelHeader, PanelTitle, Stat } from "./ui.js";
import type { IntegrationCandidateView } from "../../src/dashboard/service.js";

interface IntegrationBoardProps {
  candidates: IntegrationCandidateView[];
  now: number;
  onRefresh: () => void;
}

export function IntegrationBoard({ candidates, now, onRefresh }: IntegrationBoardProps) {
  const [actingOn, setActingOn] = React.useState<string | null>(null);
  
  const handleApprove = async (id: string) => {
    setActingOn(id);
    try {
      const res = await fetch(`/api/integrations/${id}/approve`, { method: "POST" });
      if (!res.ok) throw new Error("Failed to approve");
      onRefresh();
    } catch (err) {
      console.error(err);
      alert("Failed to approve integration.");
    } finally {
      setActingOn(null);
    }
  };

  const handleReject = async (id: string) => {
    setActingOn(id);
    try {
      const res = await fetch(`/api/integrations/${id}/reject`, { method: "POST" });
      if (!res.ok) throw new Error("Failed to reject");
      onRefresh();
    } catch (err) {
      console.error(err);
      alert("Failed to reject integration.");
    } finally {
      setActingOn(null);
    }
  };

  if (candidates.length === 0) {
    return (
      <Panel>
        <PanelHeader>
          <PanelTitle>Integration Candidates</PanelTitle>
        </PanelHeader>
        <PanelBody>
          <p className="text-[11px] text-[var(--content-faint)]">
            No integration candidates pending review.
          </p>
        </PanelBody>
      </Panel>
    );
  }

  return (
    <div className="grid gap-3 md:grid-cols-2">
      {candidates.map((candidate) => {
        const isActing = actingOn === candidate.id;
        
        return (
          <Panel key={candidate.id} className="flex flex-col">
            <PanelHeader>
              <div className="flex items-center gap-2">
                <PanelTitle className="truncate">Merge Gate</PanelTitle>
                <Badge tone={candidate.status === "PENDING" ? "warn" : candidate.status === "APPROVED" ? "ok" : "danger"}>
                  {candidate.status}
                </Badge>
              </div>
            </PanelHeader>
            <PanelBody className="flex flex-1 flex-col justify-between gap-4">
              <div className="space-y-3">
                <Stat label="Workspace Node" value={<Mono>{candidate.nodeId}</Mono>} />
                <div className="text-xs text-[var(--content)]">
                  <strong>Diff Summary:</strong> {candidate.diffSummary}
                </div>
              </div>
              
              {candidate.status === "PENDING" && (
                <div className="flex gap-2 justify-end mt-4">
                  <Button
                    variant="danger"
                    size="sm"
                    disabled={isActing}
                    onClick={() => handleReject(candidate.id)}
                  >
                    Reject
                  </Button>
                  <Button
                    variant="ok"
                    size="sm"
                    disabled={isActing}
                    onClick={() => handleApprove(candidate.id)}
                  >
                    Approve & Merge
                  </Button>
                </div>
              )}
            </PanelBody>
          </Panel>
        );
      })}
    </div>
  );
}
