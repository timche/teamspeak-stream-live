import { logger } from "./logger.ts";
import type { TeamSpeakClientInfo, TeamSpeakManager } from "./teamspeak.ts";
import type { TwitchClient } from "./twitch.ts";

/** A live twitch channel resolved to a connected TeamSpeak client. */
interface LiveTwitchUser {
  username: string;
  client: TeamSpeakClientInfo;
}

/**
 * Reconciles a shared "live" group against the Twitch channels currently live.
 *
 * The direction is the reverse of the Broadcast Box watcher: the users to check
 * are discovered from pre-assigned `twitch.tv/<username>` server groups (created
 * by admins, never by this service). Each poll every such username is checked on
 * Twitch, and the *connected* members of the live ones get the shared live group
 * (`🟣`), shown before their nickname in the tree.
 *
 * Only connected members are tagged: a server-group name renders in the tree
 * for online clients only, so a streamer who is live on Twitch but not in
 * TeamSpeak is left alone until they connect (like the Broadcast Box watcher,
 * which only ever acts on connected clients).
 *
 * The watcher keeps no in-memory state — each poll diffs the desired state
 * against what actually exists on the server, so it self-heals across restarts.
 */
export class TwitchWatcher {
  readonly #twitch: TwitchClient;
  readonly #teamspeak: TeamSpeakManager;
  readonly #liveGroupSgid: string;
  readonly #twitchGroupPrefix: string;
  readonly #publicTwitchHost: string;
  readonly #liveMessageTemplate: string;

  constructor(
    twitch: TwitchClient,
    teamspeak: TeamSpeakManager,
    liveGroupSgid: string,
    options: { twitchGroupPrefix: string; publicTwitchHost: string; liveMessageTemplate: string },
  ) {
    this.#twitch = twitch;
    this.#teamspeak = teamspeak;
    this.#liveGroupSgid = liveGroupSgid;
    this.#twitchGroupPrefix = options.twitchGroupPrefix;
    this.#publicTwitchHost = options.publicTwitchHost;
    this.#liveMessageTemplate = options.liveMessageTemplate;
  }

  /** Runs a single reconciliation cycle. */
  async reconcile(signal?: AbortSignal): Promise<void> {
    const groups = await this.#teamspeak.listTwitchGroups(this.#twitchGroupPrefix);
    const currentMembers = await this.#teamspeak.listGroupMemberDbids(this.#liveGroupSgid);

    // No twitch.tv/ groups exist: clear the shared group and skip Twitch entirely.
    if (groups.length === 0) {
      await this.#removeMembers(currentMembers);

      return;
    }

    const usernames = [...new Set(groups.map((group) => group.username))];
    const liveUsernames = await this.#twitch.fetchLiveUsernames(usernames, signal);

    // Nothing is live: clear the shared group and skip the (larger) client list.
    if (liveUsernames.size === 0) {
      await this.#removeMembers(currentMembers);

      return;
    }

    // Tag only connected members — an offline member cannot show the prefix.
    const clients = await this.#teamspeak.listClients();
    const clientByDbid = new Map(clients.map((client) => [client.databaseId, client]));

    const desired = new Map<string, LiveTwitchUser>();
    for (const group of groups) {
      if (!liveUsernames.has(group.username)) {
        continue;
      }

      for (const databaseId of group.members) {
        const client = clientByDbid.get(databaseId);

        if (client === undefined) {
          logger.debug(
            `Twitch channel "${group.username}" is live but member dbid=${databaseId} is not connected`,
          );
          continue;
        }

        desired.set(databaseId, { username: group.username, client });
      }
    }

    await this.#reconcileMembership(currentMembers, desired);
  }

  /** Best-effort teardown for shutdown: empty the shared group. */
  async cleanup(): Promise<void> {
    const members = await this.#teamspeak.listGroupMemberDbids(this.#liveGroupSgid);
    await this.#removeMembers(members);
  }

  async #reconcileMembership(
    current: Set<string>,
    desired: Map<string, LiveTwitchUser>,
  ): Promise<void> {
    // Newly-live users are handled one after another so the query client's
    // channel hop and the channel message stay in step per user.
    for (const [databaseId, user] of desired) {
      if (current.has(databaseId)) {
        continue;
      }

      try {
        await this.#teamspeak.addClientToGroup(databaseId, this.#liveGroupSgid);
        logger.info(`Added dbid=${databaseId} to the Twitch live group`);
      } catch (error) {
        logger.error(`Failed to add dbid=${databaseId} to the Twitch live group:`, message(error));
        continue;
      }

      await this.#announce(user);
    }

    for (const databaseId of current) {
      if (desired.has(databaseId)) {
        continue;
      }

      try {
        await this.#teamspeak.removeClientFromGroup(databaseId, this.#liveGroupSgid);
        logger.info(`Removed dbid=${databaseId} from the Twitch live group`);
      } catch (error) {
        logger.error(
          `Failed to remove dbid=${databaseId} from the Twitch live group:`,
          message(error),
        );
      }
    }
  }

  /** Public Twitch URL for a channel, e.g. `https://twitch.tv/alice`. */
  #streamLink(username: string): string {
    return `https://${this.#publicTwitchHost}/${username}`;
  }

  /**
   * Best-effort go-live announcement in the channel the user is currently in.
   * Fires once per go-live because it is derived from the shared-group
   * membership transition.
   */
  async #announce(user: LiveTwitchUser): Promise<void> {
    if (this.#liveMessageTemplate === "") {
      return;
    }

    const text = this.#liveMessageTemplate
      .replaceAll("{nickname}", user.client.nickname)
      .replaceAll("{link}", this.#streamLink(user.username));

    try {
      await this.#teamspeak.sendChannelMessage(user.client.channelId, text);
      logger.info(
        `Announced "${user.client.nickname}" live on Twitch in channel ${user.client.channelId}`,
      );
    } catch (error) {
      logger.error(
        `Failed to announce "${user.client.nickname}" as live on Twitch:`,
        message(error),
      );
    }
  }

  async #removeMembers(databaseIds: Set<string>): Promise<void> {
    for (const databaseId of databaseIds) {
      try {
        await this.#teamspeak.removeClientFromGroup(databaseId, this.#liveGroupSgid);
      } catch (error) {
        logger.error(
          `Failed to remove dbid=${databaseId} from the Twitch live group:`,
          message(error),
        );
      }
    }
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
