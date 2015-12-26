# -*- coding: utf-8 -*-
from openerp import models, fields, api, _
from openerp.exceptions import Warning
import openerp.addons.decimal_precision as dp


class internal_transfer(models.Model):
    _name = "internal.transfer"
    _description = "internal.transfer"
    _rec_name = 'ref'

    ref = fields.Char('Memo', required=True, readonly=True, states={'draft': [('readonly', False)]}, )
    check_num = fields.Char('Reference', required=True, readonly=True, states={'draft': [('readonly', False)]}, )
    date = fields.Date('Date', readonly=True, states={'draft': [('readonly', False)]}, )
    company_id = fields.Many2one('res.company', string='Company', required=True, readonly=True,
                                 states={'draft': [('readonly', False)]},
                                 default=lambda self: self.env['res.company']._company_default_get('account.transfer'))
    source_journal_id = fields.Many2one('account.journal', 'Source', required=True, ondelete='cascade', readonly=True,
                                        states={'draft': [('readonly', False)]},
                                        domain="[('type', 'in', ['bank', 'cash']), "
                                               "('allow_account_transfer', '=', True), "
                                               "('company_id', '=', company_id)]")
    target_journal_id = fields.Many2one('account.journal', 'Target', required=True, ondelete='cascade', readonly=True,
                                        states={'draft': [('readonly', False)]},
                                        domain="[('type', 'in', ['bank', 'cash']), "
                                               "('allow_account_transfer', '=', True), "
                                               "('company_id', '=', company_id)]")
    source_move_id = fields.Many2one('account.move', 'Source Move', readonly=True, )
    target_move_id = fields.Many2one('account.move', 'Target Move', readonly=True, )
    state = fields.Selection([('draft', 'Draft'),
                              ('confirmed', 'Confirmed'),
                              ('cancel', 'Cancel')],
                             'State', required=True, readonly=True, default='draft')
    amount = fields.Float('Amount', required=True, digits=dp.get_precision('Account'), readonly=True,
                          states={'draft': [('readonly', False)]}, )

    @api.one
    @api.constrains('source_journal_id', 'target_journal_id')
    def check_companies(self):
        if (self.source_journal_id.company_id != self.company_id
            or
                    self.target_journal_id.company_id != self.company_id):
            raise Warning(_('Both Journals must belong to the same company!'))

    @api.multi
    def action_confirm(self):
        self.ensure_one()
        if self.amount <= 0.0:
            raise Warning(_('Amount must be greater than 0!'))
        if not self.date:
            self.date = fields.Date.context_today(self)
        source_move = self.source_move_id.create(self.get_move_vals('source'))
        target_move = self.target_move_id.create(self.get_move_vals('target'))
        bank_cash_object = self.env['account.bank.statement']
        bank_cash_object_line = self.env['account.bank.statement.line']
        soruce_balance = bank_cash_object.search([('journal_id', '=', self.source_journal_id.id)])._ids
        target_balance = bank_cash_object.search([('journal_id', '=', self.target_journal_id.id)])._ids
        if not soruce_balance:
            raise Warning(_('You have to define at least 1 intial record for this Source journal '))
        elif not target_balance:
            raise Warning(_('You have to define at least 1 intial record for this Target journal  '))
        else:
            last_target_id = max(target_balance)
            last_source_id = max(soruce_balance)
            if last_source_id <> last_target_id:
                if self.source_journal_id.type == 'bank':
                    for i in bank_cash_object.browse(last_source_id):
                        x = bank_cash_object.create({'journal_id': i.journal_id.id,
                                                     'balance_start': i.balance_end_real,
                                                     'balance_end_real': (i.balance_end_real - self.amount),
                                                     'date': i.date,
                                                     'period_id': i.period_id.id,
                                                     'state': 'open'
                                                     })
                        bank_cash_object_line.create({'statement_id': x.id,
                                                      'name': x.id,
                                                      'amount': -self.amount,
                                                      })
                    for i in bank_cash_object.browse(last_target_id):
                        y = bank_cash_object.create({'journal_id': i.journal_id.id,
                                                     'balance_start': i.balance_end_real,
                                                     'balance_end_real': (i.balance_end_real + self.amount),
                                                     'date': i.date,
                                                     'state': 'open',
                                                     'period_id': i.period_id.id,

                                                     })
                        bank_cash_object_line.create({'statement_id': y.id,
                                                      'name': y.id,
                                                      'amount': self.amount,
                                                      })
                elif self.source_journal_id.type == 'cash':
                    for i in bank_cash_object.browse(last_source_id):
                        x = bank_cash_object.create({'journal_id': i.journal_id.id,
                                                     'balance_start': i.balance_end_real,
                                                     'balance_end_real': (i.balance_end_real - self.amount),
                                                     'date': i.date,
                                                     'period_id': i.period_id.id,
                                                     'state': 'open',
                                                     })
                        bank_cash_object_line.create({'statement_id': x.id,
                                                      'name': x.id,
                                                      'amount': -self.amount,
                                                      })
                    for i in bank_cash_object.browse(last_target_id):
                        y = bank_cash_object.create({'journal_id': i.journal_id.id,
                                                     'balance_start': i.balance_end_real,
                                                     'balance_end_real': (i.balance_end_real + self.amount),
                                                     'date': i.date,
                                                     'period_id': i.period_id.id,
                                                     'state': 'open'
                                                     })
                        bank_cash_object_line.create({'statement_id': y.id,
                                                      'name': y.id,
                                                      'amount': self.amount,
                                                      })
            elif self.source_journal_id.type == self.target_journal_id.type:
                for i in bank_cash_object.browse(last_target_id):
                    y = bank_cash_object.create({'journal_id': i.journal_id.id,
                                                 'balance_start': i.balance_end_real,
                                                 'balance_end_real': (i.balance_end_real + self.amount),
                                                 'date': i.date,
                                                 'period_id': i.period_id.id,
                                                 'state': 'open',})
                    bank_cash_object_line.create({'statement_id': y.id,
                                                  'name': y.id,
                                                  'amount': self.amount,
                                                  })
        self.write({
            'target_move_id': target_move.id,
            'source_move_id': source_move.id,
            'state': 'confirmed',
        })

    @api.multi
    def get_move_vals(self, move_type):
        self.ensure_one()

        transfer_account = self.company_id.transfer_account_id
        if not transfer_account:
            raise Warning(_(
                    'No transfer account configured con company %s!') % (
                              self.source_journal_id.company_id.name))

        if move_type == 'source':
            ref = _('%s - From' % self.ref)
            journal = self.source_journal_id
            first_account = journal.default_debit_account_id
            second_account = transfer_account
        if move_type == 'target':
            ref = _('%s - To' % self.ref)
            journal = self.target_journal_id
            first_account = transfer_account
            second_account = journal.default_credit_account_id

        name = journal.sequence_id._next()
        move_vals = {
            'ref': ref,
            'name': name,
            'date': self.date,
            'journal_id': journal.id,
            'company_id': self.company_id.id,
        }
        first_line_vals = {
            'name': name,
            'debit': 0.0,
            'credit': self.amount,
            'account_id': first_account.id,
        }
        second_line_vals = {
            'name': name,
            'debit': self.amount,
            'credit': 0.0,
            'account_id': second_account.id,
        }
        move_vals['line_id'] = [
            (0, _, first_line_vals), (0, _, second_line_vals)]
        return move_vals

    @api.multi
    def action_to_draft(self):
        self.write({'state': 'draft'})
        return True

    @api.one
    def action_cancel(self):
        self.source_move_id.unlink()
        self.target_move_id.unlink()
        self.state = 'cancel'

internal_transfer()

class account_journal(models.Model):
    _inherit = "account.journal"

    allow_account_transfer = fields.Boolean(
        'Allow Account Transfer?',
        default=True,
        help='Set if this journals can be used on account transfers'
        )
account_journal()

class res_company(models.Model):

    _inherit = 'res.company'

    transfer_account_id = fields.Many2one(
        'account.account',
        'Transfer Account',
        domain="[('company_id', '=', id), "
        "('type', 'not in', ('view', 'closed', 'consolidation'))]",
        help="Account used on transfers between Bank and Cash Journals"
        )
        
res_company()
