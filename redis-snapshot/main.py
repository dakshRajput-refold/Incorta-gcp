from google.cloud import compute_v1
import datetime

PROJECT = "incorta-cobalt"
ZONE = "us-central1-c"
DISK = "instance-redis-skc"
MAX_SNAPSHOTS = 5


def snapshot_redis(event, context):

    timestamp = datetime.datetime.utcnow().strftime("%Y%m%d-%H%M")
    snapshot_name = f"redis-snapshot-{timestamp}"

    disks_client = compute_v1.DisksClient()
    snapshots_client = compute_v1.SnapshotsClient()

    # Create snapshot
    snapshot_body = compute_v1.Snapshot()
    snapshot_body.name = snapshot_name

    operation = disks_client.create_snapshot(
        project=PROJECT,
        zone=ZONE,
        disk=DISK,
        snapshot_resource=snapshot_body,
    )

    print(f"Snapshot creation started: {snapshot_name}")

    # List existing snapshots
    snapshots = snapshots_client.list(project=PROJECT)

    redis_snapshots = [
        s for s in snapshots
        if s.name.startswith("redis-snapshot-")
    ]

    # Sort snapshots by creation time (newest first)
    redis_snapshots.sort(
        key=lambda x: x.creation_timestamp,
        reverse=True
    )

    # Delete older snapshots if more than MAX_SNAPSHOTS
    if len(redis_snapshots) > MAX_SNAPSHOTS:

        old_snapshots = redis_snapshots[MAX_SNAPSHOTS:]

        for snapshot in old_snapshots:

            print(f"Deleting old snapshot: {snapshot.name}")

            snapshots_client.delete(
                project=PROJECT,
                snapshot=snapshot.name
            )
