# -*- coding: utf-8 -*-

import openerp
from openerp import netsvc, tools, pooler
from openerp.osv import fields, osv
from openerp.tools.translate import _
import time


class inherit_pos_order_for_cashiers(osv.osv):
    _name = 'pos.order'
    _inherit = 'pos.order'

    def get_the_product(self, cr, uid,pos_config, context={}):
        iopo=int(pos_config)
        cr.execute(
            """select config_id from pos_session where id=%d"""%(iopo))
        zoka1 = cr.dictfetchall()
        sasa=[li['config_id'] for li in zoka1]
        print('config_id',sasa)
        cr.execute(
            """select i.prefix from pos_config p , ir_sequence i where i.id=p.sequence_id and p.id=%d"""%(int(sasa[0])))
        zoka2 = cr.dictfetchall()
        darsh=[li['prefix'] for li in zoka2]
        st =  darsh[0]
        st = st[:-1]
        print('prefix : ',st)
        cr.execute(
            """select name from pos_order where name like '%s'||'%%' order by id DESC limit 1"""%(st))
        zoka3 = cr.dictfetchall()
        if zoka3:
            ido = [li['name'] for li in zoka3]
            print([["on_this", ido[0]]])
            return [["on_this", ido[0]]]
        if not zoka3:
            return [["on_this", darsh[0]]]



    def create_from_ui(self, cr, uid, orders, context=None):
        # _logger.info("orders: %r", orders)
        order_ids = []
        for tmp_order in orders:
            order = tmp_order['data']
            order_id = self.create(cr, uid, {
                'name': order['name'],
                'user_id': order['user_id'] or False,
                'session_id': order['pos_session_id'],
                'lines': order['lines'],
                'pos_reference': order['name'],
                'sales_person': order.get('sales_person') or '-',
            }, context)

            for payments in order['statement_ids']:
                payment = payments[2]
                self.add_payment(cr, uid, order_id, {
                    'amount': payment['amount'] or 0.0,
                    'payment_date': payment['name'],
                    'statement_id': payment['statement_id'],
                    'payment_name': payment.get('note', False),
                    'journal': payment['journal_id']
                }, context=context)

            if order['amount_return']:
                session = self.pool.get('pos.session').browse(cr, uid, order['pos_session_id'], context=context)
                cash_journal = session.cash_journal_id
                cash_statement = False
                if not cash_journal:
                    cash_journal_ids = filter(lambda st: st.journal_id.type == 'cash', session.statement_ids)
                    if not len(cash_journal_ids):
                        raise osv.except_osv(_('error!'),
                                             _(
                                                 "No cash statement found for this session. Unable to record returned cash."))
                    cash_journal = cash_journal_ids[0].journal_id
                self.add_payment(cr, uid, order_id, {
                    'amount': -order['amount_return'],
                    'payment_date': time.strftime('%Y-%m-%d %H:%M:%S'),
                    'payment_name': _('return'),
                    'journal': cash_journal.id,
                }, context=context)
            order_ids.append(order_id)
            wf_service = netsvc.LocalService("workflow")
            wf_service.trg_validate(uid, 'pos.order', order_id, 'paid', cr)
        return order_ids

    _columns = {
        'sales_person': fields.many2one('res.users', string='Sales person'),
    }


inherit_pos_order_for_cashiers()
