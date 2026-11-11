"""R2 listing pages must be complete before weight availability is accepted."""
import importlib.util
from pathlib import Path
from unittest import TestCase, main
from unittest.mock import Mock

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('inventory', ROOT / 'scripts/vast-transfer-inventory.py')
inventory = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inventory)


class InventoryTests(TestCase):
    def test_lists_every_page_and_preserves_storage_class(self):
        target = Mock()
        target._request.side_effect = [(200, {}, b'<ListBucketResult xmlns="urn:s3"><IsTruncated>true</IsTruncated><NextContinuationToken>next</NextContinuationToken><Contents><Key>weights/a</Key><Size>10</Size><StorageClass>STANDARD</StorageClass></Contents></ListBucketResult>'),
            (200, {}, b'<ListBucketResult xmlns="urn:s3"><IsTruncated>false</IsTruncated><Contents><Key>weights/b</Key><Size>20</Size><StorageClass>STANDARD_IA</StorageClass></Contents></ListBucketResult>')]
        result = inventory.r2_objects(target, 'weights')
        self.assertEqual({'weights/a', 'weights/b'}, set(result))
        self.assertEqual('STANDARD_IA', result['weights/b']['storageClass'])
        self.assertEqual('next', target._request.call_args.kwargs['query']['continuation-token'])

    def test_rejects_truncated_inventory_without_cursor(self):
        target = Mock()
        target._request.return_value = (200, {}, b'<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>')
        with self.assertRaises(RuntimeError):
            inventory.r2_objects(target, 'weights')


if __name__ == '__main__':
    main()
