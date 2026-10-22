import type { PermissionRequests } from "../../shared/permissions";
import type { ApprovalService } from "./approval-service";
import { permissionSchemas } from "./validation";
import { PermissionError } from "./types";
export function permissionHandlers(
  service: ApprovalService,
  reviewer: () => object | undefined,
) {
  const owner = () => {
    const value = reviewer();
    if (!value) throw new PermissionError("PERMISSION_DENIED");
    return value;
  };
  return {
    permissionsGet: (raw: PermissionRequests["permissionsGet"]["input"]) => {
      owner();
      const v = permissionSchemas.permissionsGet.parse(raw);
      return service.snapshot(v.conversationId);
    },
    permissionReply: (raw: PermissionRequests["permissionReply"]["input"]) =>
      service.reply(permissionSchemas.permissionReply.parse(raw), owner()),
    permissionRevoke: (
      raw: PermissionRequests["permissionRevoke"]["input"],
    ) => {
      const v = permissionSchemas.permissionRevoke.parse(raw);
      return service.revoke(v.conversationId, v.grantId, owner());
    },
    permissionRulesUpdate: (
      raw: PermissionRequests["permissionRulesUpdate"]["input"],
    ) =>
      service.updateRules(
        permissionSchemas.permissionRulesUpdate.parse(raw),
        owner(),
      ),
    permissionSelectFiles: (
      raw: PermissionRequests["permissionSelectFiles"]["input"],
    ) => {
      owner();
      permissionSchemas.permissionSelectFiles.parse(raw);
      // P2 must provide a verified FileBoundary before a picker can create file authority.
      throw new PermissionError("CAPABILITY_UNSUPPORTED");
    },
  };
}
