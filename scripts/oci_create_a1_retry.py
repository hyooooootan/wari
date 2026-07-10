#!/usr/bin/env python3
import argparse
import base64
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

try:
    import oci
    from oci.exceptions import ServiceError
except ImportError:
    print("OCI Python SDK が見つかりません。`pip install oci` を実行してください。", file=sys.stderr)
    sys.exit(2)


ALLOWED_SHAPE = "VM.Standard.A1.Flex"
DEFAULT_CONFIG_FILE = "~/.oci/config"
DEFAULT_PROFILE = "DEFAULT"
DEFAULT_RETRY_WAIT_SECONDS = 300
RESULT_FILE = "INSTANCE_CREATED.json"

REQUIRED_FIELDS = [
    "compartment_id",
    "availability_domain",
    "subnet_id",
    "image_id",
    "display_name",
    "shape",
    "ocpus",
    "memory_gb",
    "boot_volume_gb",
    "ssh_public_key_path",
]

CAPACITY_ERROR_MARKERS = [
    "out of capacity",
    "out of host capacity",
    "not enough capacity",
    "capacity is not available",
    "insufficient capacity",
    "too many requests",
    "toomanyrequests",
]


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def log(message):
    print(f"[{utc_now()}] {message}", flush=True)


def load_json_config(path):
    config_path = Path(path).expanduser()
    if not config_path.exists():
        raise ValueError(f"設定ファイルが見つかりません: {config_path}")

    with config_path.open("r", encoding="utf-8") as f:
        data = json.load(f)

    if not isinstance(data, dict):
        raise ValueError("設定ファイルの最上位は JSON object にしてください。")

    return data


def validate_settings(settings):
    missing = [field for field in REQUIRED_FIELDS if settings.get(field) in (None, "")]
    if missing:
        raise ValueError("設定不足: " + ", ".join(missing))

    if settings["shape"] != ALLOWED_SHAPE:
        raise ValueError(f"作成できる Shape は {ALLOWED_SHAPE} に制限しています。")

    ocpus = settings["ocpus"]
    memory_gb = settings["memory_gb"]
    boot_volume_gb = settings["boot_volume_gb"]
    retry_wait_seconds = settings.get("retry_wait_seconds", DEFAULT_RETRY_WAIT_SECONDS)

    if not isinstance(ocpus, (int, float)) or ocpus <= 0:
        raise ValueError("ocpus は 0 より大きい数値にしてください。")
    if not isinstance(memory_gb, (int, float)) or memory_gb <= 0:
        raise ValueError("memory_gb は 0 より大きい数値にしてください。")
    if not isinstance(boot_volume_gb, int) or boot_volume_gb < 50:
        raise ValueError("boot_volume_gb は 50 以上の整数にしてください。")
    if not isinstance(retry_wait_seconds, int) or retry_wait_seconds < 60:
        raise ValueError("retry_wait_seconds は 60 以上の整数にしてください。")


def read_ssh_public_key(path):
    public_key_path = Path(path).expanduser()
    if not public_key_path.exists():
        raise ValueError(f"SSH公開鍵が見つかりません: {public_key_path}")
    if public_key_path.suffix.lower() != ".pub":
        raise ValueError("ssh_public_key_path には .pub の公開鍵ファイルを指定してください。")

    public_key = public_key_path.read_text(encoding="utf-8").strip()
    if not public_key:
        raise ValueError("SSH公開鍵ファイルが空です。")
    if "PRIVATE KEY" in public_key:
        raise ValueError("秘密鍵ではなく、SSH公開鍵 .pub を指定してください。")
    return public_key


def read_cloud_init_user_data(settings):
    script_path = settings.get("cloud_init_script_path")
    if not script_path:
        return None

    path = Path(script_path).expanduser()
    if not path.exists():
        raise ValueError(f"cloud_init_script_path was not found: {path}")

    content = path.read_bytes()
    if not content:
        raise ValueError("cloud_init_script_path is empty.")

    return base64.b64encode(content).decode("ascii")


def load_oci_config(settings):
    config_file = Path(settings.get("oci_config_file", DEFAULT_CONFIG_FILE)).expanduser()
    profile = settings.get("profile", DEFAULT_PROFILE)
    return oci.config.from_file(file_location=str(config_file), profile_name=profile)


def is_capacity_error(error):
    text = f"{getattr(error, 'code', '')} {getattr(error, 'message', '')}".lower()
    return any(marker in text for marker in CAPACITY_ERROR_MARKERS)


def service_error_summary(error):
    code = getattr(error, "code", "Unknown")
    status = getattr(error, "status", "Unknown")
    message = getattr(error, "message", str(error))
    opc_request_id = getattr(error, "opc_request_id", None)
    parts = [f"status={status}", f"code={code}", f"message={message}"]
    if opc_request_id:
        parts.append(f"opc-request-id={opc_request_id}")
    return ", ".join(parts)


def list_active_instances(compute_client, compartment_id, display_name):
    instances = []
    response = oci.pagination.list_call_get_all_results(
        compute_client.list_instances,
        compartment_id=compartment_id,
        display_name=display_name,
    )
    for instance in response.data:
        if instance.lifecycle_state not in ("TERMINATED", "TERMINATING"):
            instances.append(instance)
    return instances


def get_primary_public_ip(compute_client, network_client, compartment_id, instance_id):
    attachments = oci.pagination.list_call_get_all_results(
        compute_client.list_vnic_attachments,
        compartment_id=compartment_id,
        instance_id=instance_id,
    ).data

    for attachment in attachments:
        if attachment.lifecycle_state == "ATTACHED" and attachment.vnic_id:
            vnic = network_client.get_vnic(attachment.vnic_id).data
            if getattr(vnic, "is_primary", False):
                return vnic.public_ip

    for attachment in attachments:
        if attachment.lifecycle_state == "ATTACHED" and attachment.vnic_id:
            vnic = network_client.get_vnic(attachment.vnic_id).data
            return vnic.public_ip

    return None


def wait_for_public_ip(compute_client, network_client, compartment_id, instance_id, timeout_seconds=600):
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        public_ip = get_primary_public_ip(compute_client, network_client, compartment_id, instance_id)
        if public_ip:
            return public_ip
        time.sleep(10)
    return None


def infer_ssh_user(settings):
    configured_user = settings.get("ssh_user")
    if configured_user:
        return configured_user

    image_name = " ".join(
        str(settings.get(key, ""))
        for key in ("image_name", "os", "operating_system")
    ).lower()
    if "oracle" in image_name:
        return "opc"
    return "ubuntu"


def private_key_path_from_public_key(public_key_path):
    path_text = str(public_key_path)
    if path_text.lower().endswith(".pub"):
        return path_text[:-4]
    return path_text


def ssh_command(private_key_path, ssh_user, public_ip):
    return f"ssh -i {private_key_path} {ssh_user}@{public_ip}"


def launch_instance(compute_client, settings, ssh_public_key):
    metadata = {
        "ssh_authorized_keys": ssh_public_key,
    }
    user_data = read_cloud_init_user_data(settings)
    if user_data:
        metadata["user_data"] = user_data

    launch_details = oci.core.models.LaunchInstanceDetails(
        availability_domain=settings["availability_domain"],
        compartment_id=settings["compartment_id"],
        display_name=settings["display_name"],
        shape=settings["shape"],
        shape_config=oci.core.models.LaunchInstanceShapeConfigDetails(
            ocpus=float(settings["ocpus"]),
            memory_in_gbs=float(settings["memory_gb"]),
        ),
        source_details=oci.core.models.InstanceSourceViaImageDetails(
            image_id=settings["image_id"],
            boot_volume_size_in_gbs=int(settings["boot_volume_gb"]),
        ),
        create_vnic_details=oci.core.models.CreateVnicDetails(
            subnet_id=settings["subnet_id"],
            assign_public_ip=True,
        ),
        metadata=metadata,
    )
    return compute_client.launch_instance(launch_details).data


def wait_for_instance_running(compute_client, instance_id):
    response = oci.wait_until(
        compute_client,
        compute_client.get_instance(instance_id),
        "lifecycle_state",
        "RUNNING",
        max_wait_seconds=1800,
        max_interval_seconds=30,
    )
    return response.data


def save_result(result):
    result_path = Path(RESULT_FILE)
    with result_path.open("w", encoding="utf-8") as f:
        json.dump(result, f, indent=2, ensure_ascii=False)
        f.write("\n")
    return result_path.resolve()


def print_result(result):
    print("")
    print("作成結果")
    print(f"Instance OCID: {result['instance_id']}")
    print(f"Public IP: {result.get('public_ip') or '(取得待ち)'}")
    print(f"SSH user: {result['ssh_user']}")
    if result.get("ssh_command"):
        print(f"SSH command: {result['ssh_command']}")
    print(f"Saved: {result['result_file']}")


def build_result(settings, instance, public_ip, result_path=None):
    public_key_path = settings["ssh_public_key_path"]
    private_key_path = settings.get("ssh_private_key_path") or private_key_path_from_public_key(public_key_path)
    ssh_user = infer_ssh_user(settings)
    command = ssh_command(private_key_path, ssh_user, public_ip) if public_ip else None
    return {
        "created_at": utc_now(),
        "instance_id": instance.id,
        "display_name": instance.display_name,
        "lifecycle_state": instance.lifecycle_state,
        "availability_domain": instance.availability_domain,
        "shape": instance.shape,
        "public_ip": public_ip,
        "ssh_user": ssh_user,
        "ssh_command": command,
        "result_file": str(result_path) if result_path else str(Path(RESULT_FILE).resolve()),
    }


def parse_args():
    parser = argparse.ArgumentParser(description="OCI A1 Flex インスタンスを容量が出るまで一定間隔で作成試行します。")
    parser.add_argument("--config", required=True, help="JSON設定ファイルのパス")
    return parser.parse_args()


def main():
    args = parse_args()

    try:
        settings = load_json_config(args.config)
        validate_settings(settings)
        ssh_public_key = read_ssh_public_key(settings["ssh_public_key_path"])
        oci_config = load_oci_config(settings)
    except (
        ValueError,
        json.JSONDecodeError,
        oci.exceptions.ConfigFileNotFound,
        oci.exceptions.InvalidConfig,
        oci.exceptions.ProfileNotFound,
    ) as error:
        print(f"設定エラー: {error}", file=sys.stderr)
        return 2

    compute_client = oci.core.ComputeClient(oci_config)
    network_client = oci.core.VirtualNetworkClient(oci_config)

    display_name = settings["display_name"]
    compartment_id = settings["compartment_id"]
    retry_wait_seconds = settings.get("retry_wait_seconds", DEFAULT_RETRY_WAIT_SECONDS)

    try:
        existing_instances = list_active_instances(compute_client, compartment_id, display_name)
    except ServiceError as error:
        print(f"既存インスタンス確認に失敗しました: {service_error_summary(error)}", file=sys.stderr)
        return 2

    if existing_instances:
        instance = existing_instances[0]
        try:
            public_ip = get_primary_public_ip(compute_client, network_client, compartment_id, instance.id)
        except ServiceError as error:
            print(f"既存インスタンスの Public IP 取得に失敗しました: {service_error_summary(error)}", file=sys.stderr)
            return 2
        result = build_result(settings, instance, public_ip)
        log(f"同じ Display name のインスタンスが存在します: {instance.id} ({instance.lifecycle_state})")
        print_result(result)
        return 0

    attempt = 0
    while True:
        attempt += 1
        log(f"作成試行 {attempt}: {display_name} / {ALLOWED_SHAPE} / OCPU={settings['ocpus']} / Memory={settings['memory_gb']}GB")

        try:
            instance = launch_instance(compute_client, settings, ssh_public_key)
            log(f"作成要求を受け付けました: {instance.id}")
            running_instance = wait_for_instance_running(compute_client, instance.id)
            public_ip = wait_for_public_ip(compute_client, network_client, compartment_id, running_instance.id)
            result = build_result(settings, running_instance, public_ip)
            result_path = save_result(result)
            result["result_file"] = str(result_path)
            save_result(result)
            print_result(result)
            return 0
        except KeyboardInterrupt:
            print("")
            log("Ctrl+C を受け付けたため停止します。作成済みリソースの削除は行いません。")
            return 130
        except ServiceError as error:
            if is_capacity_error(error):
                log(f"容量不足のため待機します: {service_error_summary(error)}")
                log(f"{retry_wait_seconds} 秒後に再試行します。")
                try:
                    time.sleep(retry_wait_seconds)
                except KeyboardInterrupt:
                    print("")
                    log("Ctrl+C を受け付けたため停止します。作成済みリソースの削除は行いません。")
                    return 130
                continue

            print(f"容量不足以外の OCI エラーで停止します: {service_error_summary(error)}", file=sys.stderr)
            return 2
        except Exception as error:
            print(f"予期しないエラーで停止します: {error}", file=sys.stderr)
            return 2


if __name__ == "__main__":
    sys.exit(main())
