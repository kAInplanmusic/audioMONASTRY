import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('dns_wire', ROOT/'scripts/production/wire-dns.py')
dns = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dns)


class ProductionDnsTests(unittest.TestCase):
    def setUp(self):
        self.nodes = [{'name':'audiomonastry-'+role+'-1','status':'running',
            'labels':{'app':'audiomonastry','role':role},'public_net':{'ipv4':{'ip':'1.1.1.1'}}}
            for role in ('app','sfu','media')]

    def test_plan_is_idempotent_and_only_touches_three_hosts(self):
        initial = dns.plan(self.nodes,[])
        records = [{'id':str(i),'name':item['name'],**item['after']} for i,item in enumerate(initial)]
        records.append({'id':'other','name':'unrelated.hallerbans.de','type':'A','content':'8.8.8.8','proxied':True,'ttl':1})
        self.assertTrue(all(row['changed'] for row in initial))
        self.assertFalse(any(row['changed'] for row in dns.plan(self.nodes,records)))
        self.assertEqual(set(dns.HOSTS), {row['name'] for row in initial})

    def test_conflicting_record_and_unowned_node_block_before_writes(self):
        with self.assertRaisesRegex(RuntimeError,'CONFLICTING_DNS_RECORDS'):
            dns.plan(self.nodes,[{'name':'origin.hallerbans.de','type':'CNAME'}])
        self.nodes[0]['labels']['app'] = 'other'
        with self.assertRaisesRegex(RuntimeError,'OWNERSHIP'):
            dns.plan(self.nodes,[])


if __name__ == '__main__':
    unittest.main()
